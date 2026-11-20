import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { RunsService } from "./runs.service.js";
import { RunsBoundary } from "./runs.boundary.js";
import { json, type Context, type Scoped, type Step, type Transaction } from "./runs.types.js";
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
      if (["LEARNING", "FAILED", "CANCELED"].includes(run.state))
        throw new ConflictException("Run is terminal");
      const steps = await db.videoRunStep.findMany({
        where: {
          runId: id,
          state: { in: ["RUNNING", "PENDING", "QUEUED", "WAITING_APPROVAL", "PAUSED"] },
          providerJobId: null,
        },
      });
      const active = await tx.providerRequest.findMany({
        where: {
          workspaceId: context.workspaceId,
          correlationId: { in: steps.map((step) => step.id) },
          errorCode: "VIDEO_RUN_DISPATCHING",
        },
        select: { correlationId: true },
      });
      const dispatched = new Set(active.map((request) => request.correlationId));
      await this.closeSteps(
        context,
        db,
        tx,
        id,
        steps.filter((step) => !dispatched.has(step.id)),
        "RUN_CANCELED",
      );
      await db.videoRun.updateMany({
        where: { id },
        data: { state: "CANCELED", pauseReason: null },
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
        if (!(
          run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
          run.pauseReason === "OPERATOR_ABANDONED"
        ))
          throw new ConflictException("Run is not awaiting reconciliation");
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
        const active = await tx.providerRequest.findFirst({
          where: {
            workspaceId: context.workspaceId,
            correlationId: step.id,
            errorCode: "VIDEO_RUN_DISPATCHING",
          },
        });
        if (active && !run.pauseReason?.includes(step.id))
          throw new ConflictException("Provider attempt may still be active");
        await this.closeSteps(context, db, tx, id, [step], "OPERATOR_ABANDONED");
        if (step.key.startsWith("shot-")) {
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
        await db.videoRun.updateMany({
          where: { id },
          data: { pauseReason: "OPERATOR_ABANDONED" },
        });
        return { value: null, payload: { key: step.key }, stepId };
      },
    );
    await this.runs.events?.publish(result.event);
  }
  private async closeSteps(
    context: Context,
    db: Scoped,
    tx: Transaction,
    runId: string,
    steps: Step[],
    reason: string,
  ): Promise<void> {
    const ids = steps.map((step) => step.id);
    await tx.usageReservation.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: { in: ids }, status: "RESERVED" },
      data: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason },
    });
    await tx.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: { in: ids },
        status: "FAILED",
        actualCost: null,
      },
      data: { errorCode: reason },
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
    if (run.pauseReason?.startsWith("RECONCILE_REQUIRED"))
      throw new ConflictException("Abandon the unknown attempt before resuming");
    if (run.pauseReason === "OPERATOR_ABANDONED") {
      const result = await this.runs.store.mutate(context, id, "resumed", async (db, current) => {
        if (current.pauseReason !== "OPERATOR_ABANDONED")
          throw new ConflictException("Run changed");
        const state = current.state === "PAUSED_BUDGET" ? "GENERATING" : current.state;
        await db.videoRun.updateMany({ where: { id }, data: { state, pauseReason: null } });
        return { value: null, payload: { from: current.state, to: state } };
      });
      await this.runs.events?.publish(result.event);
      await this.runs.enqueue(context, await this.runs.store.get(context, id));
      return;
    }
    if (!["PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state))
      throw new ConflictException("Run cannot resume");
    await this.runs.move(context, run, "GENERATING");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async reshoot(context: Context, id: string, ordinal: number): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC")
      throw new ConflictException("Reshoots are selected at the critic boundary");
    const db = this.runs.store.scoped(context);
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
      async (scoped) => {
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
