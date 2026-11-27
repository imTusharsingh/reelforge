import { withTextDispatch } from "../usage-budget/text-dispatch-recovery.js";
import { finalizeInvalidText } from "../usage-budget/run-paid-failure.js";
import { settledMediaSpend } from "../usage-budget/run-media-spend.js";
import type { Prisma } from "@reelforge/database";
type BudgetEnvelope = Prisma.BudgetEnvelopeGetPayload<object>;
import { InvalidCompletedText, ProviderFailure } from "@reelforge/ai-providers";
import { canRollback, readAdmission } from "../usage-budget/run-admission-state.js";
import { clearResolvedSubmissionHold, failSettledGeneration } from "../runs/run-outcomes.js";
import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  BudgetExhaustedError,
  BudgetUnresolvableError,
} from "../usage-budget/usage-budget.types.js";
import { assertCriticRevision } from "../usage-budget/critic-admission.js";
import { envelopeRoom, assertPaidRunLimits, pinnedBudget } from "../usage-budget/run-envelope.js";
import {
  json,
  type Context,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";
import { MediaAccess } from "./media-access.js";
@Injectable()
export class MediaAccounts {
  public constructor(private readonly access: MediaAccess) {}
  public async begin(
    context: Context,
    run: Run,
    key: string,
    input: unknown,
    cost: number,
    modelId: string,
  ): Promise<Step> {
    await this.access.boundary.check(context, run);
    const result = await this.access.runs.store.mutate(
      context,
      run.id,
      "media_intent",
      async (db, current, tx) => {
        this.requireDispatchable(run, current);
        const previous = await db.videoRunStep.findFirst({
          where: { runId: run.id, key },
          orderBy: { attempt: "desc" },
        });
        if (previous?.state === "FAILED")
          throw new ConflictException("Media provider request was rejected");
        if (previous && !this.abandoned(previous))
          return {
            value: previous,
            payload: { replay: true },
          };
        if (previous) await this.verifyRetry(tx, context, previous);
        await assertCriticRevision(db, tx, current, { key, input: { spec: input } });
        const { budget, warning } = await this.checkRoom(db, current, cost);
        const attempt = (previous?.attempt ?? 0) + 1;
        const step = await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key,
            attempt,
            state: "RUNNING",
            costMinor: cost,
            providerId: "gemini",
            idempotencyKey: `${run.id}:${key}:${attempt}`,
            input: json({ spec: input, modelId }),
            startedAt: new Date(),
          },
        });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: { reservedMinor: budget.reservedMinor + cost, revision: budget.revision + 1 },
          });
        return { value: step, payload: { key, costMinor: cost, ...warning }, stepId: step.id };
      },
    );
    await this.access.runs.events?.publish(result.event);
    this.assertNewIntent(result.event.payload, result.value);

    return result.value;
  }
  private async verifyRetry(tx: Transaction, context: Context, previous: Step): Promise<void> {
    const admission = await readAdmission(tx, context, previous);
    if (!canRollback(admission) && admission.evidence !== "released-nondispatch")
      throw new ConflictException(
        `RECONCILE_REQUIRED: conflicting closed attempt (${previous.id})`,
      );
  }
  private async checkRoom(
    db: Scoped,
    current: Run,
    cost: number,
  ): Promise<{
    budget: BudgetEnvelope | null;
    warning: { cumulativeMinor: number; warn: boolean } | null;
  }> {
    const cumulative = await assertPaidRunLimits(db, current, cost);
    const budget = await db.budgetEnvelope.findFirst({ where: { runId: current.id } });
    if (budget && !envelopeRoom(budget, cost)) throw new ConflictException("BUDGET_CAP");
    return { budget, warning: budget ? null : this.targetWarning(current, cumulative) };
  }
  private targetWarning(
    run: Run,
    cumulativeMinor: number,
  ): { cumulativeMinor: number; warn: boolean } {
    return { cumulativeMinor, warn: cumulativeMinor > pinnedBudget(run).targetMinor };
  }
  private requireDispatchable(run: Run, current: Run): void {
    if (
      current.state !== run.state ||
      current.pauseReason === "EMERGENCY_STOP" ||
      current.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
      current.pauseReason === "OPERATOR_ABANDONED"
    )
      throw new ConflictException("Run is not accepting media dispatch");
  }
  private assertNewIntent(payload: unknown, step: Step): void {
    if (this.record(payload).replay)
      throw new ConflictException(`RECONCILE_REQUIRED: media intent already claimed (${step.id})`);
  }
  public abandoned(step: Step): boolean {
    return (
      step.state === "CANCELLED" &&
      ["OPERATOR_ABANDONED", "NOT_DISPATCHED"].includes(String(this.record(step.output).closedBy))
    );
  }
  public async dispatch<T>(
    context: Context,
    step: Step,
    call: () => Promise<T>,
    assertLocked?: () => Promise<void>,
  ): Promise<T> {
    return this.access.paid.dispatch(context, step, call, assertLocked);
  }
  public async dispatchText<T extends { providerJobId: string }>(
    context: Context,
    step: Step,
    call: () => Promise<T>,
  ): Promise<T> {
    return withTextDispatch(step, async (check) => {
      const result = await this.dispatch(context, step, call, check).catch(
        async (error: unknown) => {
          if (error instanceof InvalidCompletedText) {
            const event = await finalizeInvalidText(
              this.access.runs.store,
              this.access.paid,
              context,
              step,
              error,
            );
            await this.access.runs.events?.publish(event);
          } else if (error instanceof ProviderFailure && !error.dispatched) {
            const event = await this.access.paid.finalizeRejected(context, step, error);
            await this.access.runs.events?.publish(event);
          }
          throw error;
        },
      );
      const attached = await this.access.runs.attachJob(
        context,
        step,
        result.providerJobId,
        json(result),
      );
      if (attached.state === "FAILED")
        throw new ConflictException("Receipt recorded for a closed text attempt");
      return result;
    });
  }
  public async reserve(context: Context, run: Run, step: Step, modelId: string): Promise<void> {
    const proof = await this.access.paid.prepareReservation(run);
    await this.access.runs.store.mutate(
      context,
      run.id,
      "media_reserved",
      async (db, current, tx) => {
        this.requireDispatchable(run, current);
        const intent = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (intent.state !== "RUNNING") throw new ConflictException("Media intent changed");
        await this.access.paid.reserve(context, current, step, step.costMinor ?? 0, tx, proof);
        await tx.providerRequest.updateMany({
          where: { workspaceId: context.workspaceId, correlationId: step.id },
          data: { providerId: "gemini", capabilityId: modelId },
        });
        return { value: null, payload: {}, stepId: step.id };
      },
    );
  }
  public async prepare(context: Context, run: Run, step: Step, modelId: string): Promise<void> {
    try {
      await this.reserve(context, run, step, modelId);
    } catch (error) {
      const denied =
        error instanceof BudgetExhaustedError ||
        error instanceof BudgetUnresolvableError ||
        (error instanceof ServiceUnavailableException &&
          error.message === "Budget policy unavailable");
      if (await this.recoverUndispatched(context, step, denied)) throw error;
      // Any persisted dispatch marker still requires reconciliation.
      await this.reconcilePending(context, step);
    }
    try {
      await this.access.boundary.check(context, await this.access.runs.store.get(context, run.id));
    } catch (error) {
      // reserve resolved successfully and submit has not been invoked.
      await this.access.paid.rollbackAdmission(context, step);
      throw error;
    }
  }
  public async recoverUndispatched(
    context: Context,
    step: Step,
    budgetDenied = false,
  ): Promise<boolean> {
    if (step.state !== "RUNNING" || step.providerJobId) return false;
    await this.access.paid.rollbackAdmission(context, step, budgetDenied);
    const current = await this.access.runs.store.scoped(context).videoRunStep.findFirstOrThrow({
      where: { id: step.id },
    });
    if (
      current.state === "CANCELLED" &&
      this.record(current.output).closedBy === "PROVIDER_NOT_DISPATCHED"
    )
      throw new ConflictException("MEDIA_NOT_DISPATCHED: provider rejected the original attempt");
    return this.abandoned(current) || (budgetDenied && current.state === "CANCELLED");
  }

  public async reconcilePending(context: Context, step: Step): Promise<never> {
    const ledger = await readAdmission(this.access.runs.store.db, context, step);
    if (canRollback(ledger)) {
      await this.access.paid.rollbackAdmission(context, step);
      throw new ConflictException("Media admission changed before reconciliation");
    }
    await this.access.runs.store.scoped(context).videoRunStep.updateMany({
      where: { id: step.id, state: "RUNNING", providerJobId: null },
      data: {
        output: json({
          reconciliationRequired: {
            idempotencyKey: `m08:${step.idempotencyKey}`,
            reservationId: ledger.reservation?.id ?? null,
            requestId: ledger.request?.id ?? null,
          },
        }),
      },
    });
    throw new ConflictException(
      `RECONCILE_REQUIRED: media paid intent requires ledger reconciliation (${step.id})`,
    );
  }
  /** The provider explicitly rejected the submission before dispatch. */
  public async cancelUndispatched(context: Context, step: Step): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "media_not_dispatched",
      async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.state === "CANCELLED") return { value: null, payload: { replay: true } };
        if (current.providerJobId || current.state !== "RUNNING")
          throw new ConflictException("Dispatched media cannot be cancelled as unsubmitted");
        await this.access.paid.finish(context, step, false, 0, tx);
        const closed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "RUNNING", providerJobId: null },
          data: { state: "CANCELLED", finishedAt: new Date() },
        });
        if (closed.count !== 1) throw new ConflictException("Media attempt changed");
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: step.runId } });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: {
              reservedMinor: budget.reservedMinor - (current.costMinor ?? 0),
              revision: budget.revision + 1,
            },
          });
        const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
        const settled =
          run.state === "NEEDS_HUMAN" &&
          step.key.startsWith("media:keyframe:") &&
          (await failSettledGeneration(db, { ...run, pauseReason }));
        return {
          value: null,
          eventType: settled ? "transition" : "media_not_dispatched",
          payload: {
            refundedMinor: step.costMinor,
            ...(settled ? { from: run.state, to: "FAILED" } : {}),
          },
          stepId: step.id,
        };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  public async complete(context: Context, step: Step, output: unknown): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "media_completed",
      async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.state === "SUCCEEDED") return { value: null, payload: { replay: true } };
        if (current.state === "FAILED") throw new ConflictException("Media attempt already failed");
        await this.access.paid.commitJob(tx, context, current, current.costMinor ?? 0);
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: step.runId } });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: {
              reservedMinor: budget.reservedMinor - (step.costMinor ?? 0),
              spentMinor: budget.spentMinor + (step.costMinor ?? 0),
              revision: budget.revision + 1,
            },
          });
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "SUCCEEDED",
            finishedAt: new Date(),
            output: json({ result: output, budgetAccounted: !!budget }),
          },
        });
        const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
        if (run.state === "NEEDS_HUMAN" && step.key.startsWith("media:keyframe:"))
          await failSettledGeneration(db, { ...run, pauseReason });
        const paid = budget
          ? null
          : await db.videoRunStep.aggregate({
              where: { runId: run.id, state: "SUCCEEDED", key: { startsWith: "media:" } },
              _sum: { costMinor: true },
            });
        const cumulativeMinor = paid?._sum.costMinor ?? 0;
        return {
          value: null,
          payload: {
            costMinor: step.costMinor,
            ...(paid && this.targetWarning(run, cumulativeMinor)),
          },
          stepId: step.id,
        };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  public async sync(context: Context, run: Run): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      run.id,
      "media_budget_reconciled",
      async (db) => {
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
        if (!budget) return { value: null, payload: { pending: true } };
        // Historical envelopes may already include unmarked planning steps or a duplicate sync.
        const spentMinor = await settledMediaSpend(db, run.id);
        const cost = spentMinor - budget.spentMinor;
        if (cost)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id },
            data: { spentMinor, revision: budget.revision + 1 },
          });
        return { value: null, payload: { costMinor: cost } };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  private record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
