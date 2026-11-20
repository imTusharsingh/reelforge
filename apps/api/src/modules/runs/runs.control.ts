import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { RunsService } from "./runs.service.js";
import { RunsBoundary } from "./runs.boundary.js";
import {
  json,
  type Context,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "./runs.types.js";
import { remainingSubmissionHold, SETTLED_SHOTS, submissionHold } from "./run-outcomes.js";
import { canRollback, readAdmission, readAdmissions } from "../usage-budget/run-admission-state.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";

@Injectable()
export class RunsControl {
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
  ) {}
  public async approve(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state === "AWAITING_APPROVAL") {
      // Scheduling/publishing is V9; record the approval and preserve the locked transition map.
      const result = await this.runs.store.mutate(context, id, "approved", async (db, current) => {
        if (current.state !== "AWAITING_APPROVAL") throw new ConflictException("Already approved");
        await db.videoRun.updateMany({
          where: { id },
          data: { state: "SCHEDULED", pauseReason: null },
        });
        return { value: null, payload: { from: "AWAITING_APPROVAL", to: "SCHEDULED" } };
      });
      await this.runs.events?.publish(result.event);
    } else {
      if (run.effectiveAutonomy !== "L1") throw new ConflictException("No stage approval required");
      const result = await this.runs.store.mutate(context, id, "stage_approved", async (db) => {
        const changed = await db.videoRunStep.updateMany({
          where: { runId: id, key: run.state, state: "WAITING_APPROVAL" },
          data: { state: "SUCCEEDED" },
        });
        if (!changed.count) throw new ConflictException("No stage awaiting approval");
        return { value: null, payload: { stage: run.state } };
      });
      await this.runs.events?.publish(result.event);
      await this.runs.enqueue(context, await this.runs.store.get(context, id));
    }
  }
  public async reedit(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC") throw new ConflictException("Re-edit requires critic boundary");
    const result = await this.runs.store.mutate(context, id, "reedit_requested", async (db) => {
      const key = `${id}:REEDIT:1`;
      if (await db.videoRunStep.findFirst({ where: { runId: id, key: "REEDIT" } }))
        throw new ConflictException("Only one full re-edit per run");
      await db.videoRunStep.create({
        data: {
          workspaceId: context.workspaceId,
          runId: id,
          key: "REEDIT",
          idempotencyKey: key,
          input: {},
        },
      });
      return { value: null, payload: { fullReedits: 1 } };
    });
    await this.runs.events?.publish(result.event);
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async cancel(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const result = await this.runs.store.mutate(context, id, "transition", async (db, run, tx) => {
      if (["PUBLISHED", "LEARNING", "FAILED", "CANCELED"].includes(run.state))
        throw new ConflictException("Run is terminal");
      const steps = await db.videoRunStep.findMany({
        where: {
          runId: id,
          state: { notIn: [...SETTLED_SHOTS] },
          providerJobId: null,
        },
      });
      const hold = await this.closeSteps(context, db, tx, id, steps);
      await db.videoRun.updateMany({
        where: { id },
        data: {
          state: "CANCELED",
          pauseReason: run.pauseReason?.startsWith("RECONCILE_REQUIRED") ? run.pauseReason : hold,
        },
      });
      return { value: null, payload: { from: run.state, to: "CANCELED" } };
    });
    await this.runs.events?.publish(result.event);
  }
  public async abandon(context: Context, id: string, stepId: string): Promise<void> {
    this.runs.editor(context);
    const result = await this.runs.store.mutate(
      context,
      id,
      "step_abandoned",
      async (db, run, tx) => {
        const step = await db.videoRunStep.findFirst({
          where: {
            id: stepId,
            runId: id,
            state: "RUNNING",
            providerJobId: null,
            OR: [{ key: { startsWith: "media:" } }, { key: { startsWith: "shot-" } }],
          },
        });
        if (!step) throw new ConflictException("Step has no unknown submission to abandon");
        const admission = await readAdmission(tx, context.workspaceId, step);
        if (!canRollback(admission)) {
          const reason = submissionHold(step.id);
          if (!run.pauseReason?.startsWith("RECONCILE_REQUIRED"))
            await db.videoRun.updateMany({ where: { id }, data: { pauseReason: reason } });
          return { value: reason, payload: { reason }, stepId, eventType: "reconcile_required" };
        }
        if (!(
          run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
          run.pauseReason === "OPERATOR_ABANDONED"
        ))
          throw new ConflictException("Run is not awaiting reconciliation");
        await this.releaseSteps(context, db, tx, id, [step], "OPERATOR_ABANDONED");
        if (run.state !== "CANCELED" && step.key.startsWith("shot-")) {
          await db.videoRunStep.create({
            data: {
              workspaceId: context.workspaceId,
              runId: id,
              key: step.key,
              attempt: step.attempt + 1,
              idempotencyKey: `${step.idempotencyKey}:retry:${step.attempt + 1}`,
              input: json(step.input),
            },
          });
        }
        await this.updateAbandonHold(db, tx, run);
        return { value: null, payload: { key: step.key }, stepId };
      },
    );
    await this.runs.events?.publish(result.event);
    if (result.value)
      throw new ConflictException("Reconcile the provider submission before abandoning");
  }
  private async updateAbandonHold(db: Scoped, tx: Transaction, run: Run): Promise<void> {
    const hold = await remainingSubmissionHold(db, tx, run);
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { pauseReason: hold ?? (run.state === "CANCELED" ? null : "OPERATOR_ABANDONED") },
    });
  }

  private async closeSteps(
    context: Context,
    db: Scoped,
    tx: Transaction,
    runId: string,
    steps: Step[],
  ): Promise<string | null> {
    const admissions = await readAdmissions(tx, context.workspaceId, steps);
    await this.releaseSteps(
      context,
      db,
      tx,
      runId,
      admissions.filter(canRollback).map(({ step }) => step),
      "RUN_CANCELED",
    );
    const protectedAttempt = admissions.find((admission) => !canRollback(admission));
    return protectedAttempt ? submissionHold(protectedAttempt.step.id) : null;
  }

  private async releaseSteps(
    context: Context,
    db: Scoped,
    tx: Transaction,
    runId: string,
    steps: Step[],
    reason: "RUN_CANCELED" | "OPERATOR_ABANDONED",
  ): Promise<void> {
    const ids = steps.map((step) => step.id);
    await tx.usageReservation.updateMany({
      where: {
        workspaceId: context.workspaceId,
        idempotencyKey: { in: steps.map((step) => `m08:${step.idempotencyKey}`) },
        status: "RESERVED",
      },
      data: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason },
    });
    await tx.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: { in: ids },
        status: "FAILED",
        actualCost: null,
      },
      data: {
        errorCode: reason,
        actualCost: 0,
        responseMetadata: { dispatched: false, costKnown: true },
      },
    });
    await db.videoRunStep.updateMany({
      where: { runId, id: { in: ids } },
      data: { state: "CANCELLED", finishedAt: new Date(), output: { closedBy: reason } },
    });
    const refunded = steps
      .filter((step) => step.state === "RUNNING")
      .reduce((sum, step) => sum + (step.costMinor ?? 0), 0);
    if (!refunded) return;
    const budget = await db.budgetEnvelope.findFirst({ where: { runId } });
    if (budget) {
      await db.budgetEnvelope.updateMany({
        where: { id: budget.id },
        data: {
          reservedMinor: Math.max(0, budget.reservedMinor - refunded),
          revision: budget.revision + 1,
        },
      });
    }
  }
  public async resume(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    const result = await this.runs.store.mutate(context, id, "resumed", async (db, current, tx) => {
      if (current.revision !== run.revision) throw new ConflictException("Run changed");
      const hold = await remainingSubmissionHold(db, tx, current);
      if (hold || current.pauseReason?.startsWith("RECONCILE_REQUIRED")) {
        if (hold && !current.pauseReason?.startsWith("RECONCILE_REQUIRED"))
          await db.videoRun.updateMany({ where: { id }, data: { pauseReason: hold } });
        return {
          value: false,
          payload: { reason: hold ?? current.pauseReason },
          eventType: "reconcile_required",
        };
      }
      const abandoned = current.pauseReason === "OPERATOR_ABANDONED";
      if (!abandoned && !["PAUSED_BUDGET", "NEEDS_HUMAN"].includes(current.state))
        throw new ConflictException("Run cannot resume");
      const state = abandoned && current.state !== "PAUSED_BUDGET" ? current.state : "GENERATING";
      await db.videoRun.updateMany({ where: { id }, data: { state, pauseReason: null } });
      return {
        value: true,
        payload: { from: current.state, to: state, reason: null },
        eventType: abandoned ? "resumed" : "transition",
      };
    });
    await this.runs.events?.publish(result.event);
    if (!result.value) throw new ConflictException("Reconcile the unknown attempt before resuming");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async reshoot(context: Context, id: string, ordinal: number): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC")
      throw new ConflictException("Reshoots are selected at the critic boundary");
    const db = this.runs.store.scoped(context);
    if (
      run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
      (await remainingSubmissionHold(db, this.runs.store.db, run))
    )
      throw new ConflictException("Reconcile the unknown attempt before reshooting");
    const previous = await db.videoRunStep.findFirstOrThrow({
      where: { runId: id, key: `shot-${ordinal}` },
      orderBy: { attempt: "desc" },
    });
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: id } });
    if (previous.attempt >= 3 || !envelopeRoom(budget, previous.costMinor ?? 0)) {
      await this.runs.move(context, run, "NEEDS_HUMAN", "Reshoot cap or envelope exhausted");
      return;
    }
    const result = await this.runs.store.mutate(
      context,
      id,
      "reshoot_requested",
      async (scoped, current) => {
        if (current.revision !== run.revision) throw new ConflictException("Run changed");
        const shot = ShotSpecSchema.parse(previous.input);
        await scoped.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: id,
            key: previous.key,
            attempt: previous.attempt + 1,
            input: shot,
            idempotencyKey: `${id}:${ordinal}:${previous.attempt + 1}`,
          },
        });
        return { value: null, payload: { ordinal, attempt: previous.attempt + 1 } };
      },
    );
    await this.runs.events?.publish(result.event);
    await this.runs.move(context, await this.runs.store.get(context, id), "GENERATING");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
}
