import { AUDIO_KEYS, failedAudio } from "../runs/run-audio.js";
import { finalizeFailed } from "./run-paid-failure.js";
import {
  canConfirmRejection,
  BILLING_OVERAGE,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  jobIdFromAdmission,
  readAdmission,
} from "./run-admission-state.js";
import { assertCriticAdmissionOpen, assertCriticRevision } from "./critic-admission.js";
import { pinnedBudget, assertPaidRunLimits } from "./run-envelope.js";
import {
  SubmissionOutcomeUnknown,
  rollbackAdmission,
  recordReservation,
} from "./run-paid-admission.js";
import {
  InvalidCompletedText,
  ProviderFailure,
  SubmissionRefused,
  providerFailureMessage,
} from "@reelforge/ai-providers";
import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { UsageBudgetService } from "./usage-budget.service.js";
import { runStepCategory, type PaidCallReservation } from "./usage-budget.types.js";
import { RunsStore } from "../runs/runs.store.js";
import {
  assertPinnedVideoRunLanguage,
  preparePinnedVideoRunLanguage,
} from "../composition/video-run-language.js";
import type { MediaReadiness } from "../composition/media-runtime.js";
import {
  json,
  type Context,
  type Event,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";

import { submissionHold, remainingSubmissionHold } from "../runs/run-outcomes.js";

export { SubmissionOutcomeUnknown } from "./run-paid-admission.js";

export class DispatchAdmissionError extends ConflictException {}

async function assertReserveAdmission(
  db: Scoped,
  transaction: Transaction,
  run: Run,
  step: Step,
  amount: number,
  context: Context,
): Promise<Awaited<ReturnType<typeof readAdmission>>> {
  assertCriticAdmissionOpen(run, step.key);
  await assertPaidRunLimits(db, run, amount, step.id);
  const admission = await readAdmission(transaction, context, step);
  if (admission.evidence !== "never-dispatched" && admission.evidence !== "rolled-back")
    throw new ConflictException(submissionHold(step.id));
  return admission;
}

/** Keep M08/M18 logical keys, with the UUID step id as the ledger correlation id. */
@Injectable()
export class RunPaidCalls {
  public constructor(
    public readonly usage: UsageBudgetService,
    private readonly store: RunsStore,
  ) {}
  public prepareReservation(run: Run): Promise<MediaReadiness | undefined> {
    return preparePinnedVideoRunLanguage(() => run.inputSnapshot);
  }
  public async reserve(
    context: Context,
    run: Run,
    step: Step,
    amount: number,
    transaction?: Transaction,
    proof?: MediaReadiness,
  ): Promise<PaidCallReservation> {
    if (!transaction) return this.reserveWithPreflight(context, run, step, amount);
    assertPinnedVideoRunLanguage(run.inputSnapshot, proof);
    const db = this.store.scoped(context, transaction);
    const admission = await assertReserveAdmission(db, transaction, run, step, amount, context);
    const result = await this.usage.reserve(
      context.workspaceId,
      {
        channelId: run.channelId,
        idempotencyKey: `m08:${step.idempotencyKey}`,
        correlationId: step.id,
        category: runStepCategory(step.key),
        currency: "USD",
        amountMinor: amount,
        ttlMs: 86400000,
      },
      transaction,
      pinnedBudget(run),
    );
    if (result.decision !== "RESERVED")
      throw new ServiceUnavailableException({
        code: result.reason,
        message: "Budget policy unavailable",
      });
    if (result.replayed) throw new ConflictException("Paid dispatch requires reconciliation");
    await recordReservation(
      transaction,
      context,
      run,
      step,
      amount,
      new Date(result.reservation.createdAt),
      admission.evidence === "rolled-back" ? admission.request?.id : undefined,
    );
    return {
      workspaceId: context.workspaceId,
      reservationId: result.reservation.id,
      currency: "USD",
      estimateMinor: amount,
    };
  }
  private async reserveWithPreflight(
    context: Context,
    run: Run,
    step: Step,
    amount: number,
  ): Promise<PaidCallReservation> {
    const prepared = await this.prepareReservation(run);
    const result = await this.store.mutate(
      context,
      run.id,
      "dispatch_reserved",
      async (_db, current, tx) => ({
        value: await this.reserve(context, current, step, amount, tx, prepared),
        payload: { amountMinor: amount },
        stepId: step.id,
      }),
    );
    return result.value;
  }

  public async dispatch<T>(
    context: Context,
    step: Step,
    call: () => Promise<T>,
    assertLocked?: () => Promise<void>,
  ): Promise<T> {
    await this.markDispatching(context, step, assertLocked).catch(async (error: unknown) => {
      await this.rollbackAdmission(context, step);
      throw error;
    });
    // The durable dispatch marker protects the claims before invoking the provider.
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof InvalidCompletedText ||
        error instanceof SubmissionRefused ||
        (error instanceof ProviderFailure && !error.dispatched)
      )
        throw error;
      return this.holdUnknown(context, step, error);
    }
  }
  private async markDispatching(
    context: Context,
    step: Step,
    assertLocked?: () => Promise<void>,
  ): Promise<void> {
    const prepared = await preparePinnedVideoRunLanguage(
      async () => (await this.store.get(context, step.runId)).inputSnapshot,
    );
    await this.store.mutate(context, step.runId, "provider_dispatch", async (db, run, tx) => {
      assertPinnedVideoRunLanguage(run.inputSnapshot, prepared);
      const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      if (
        ["CANCELED", "FAILED", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state) ||
        ["OPERATOR_ABANDONED", "EMERGENCY_STOP"].some((reason) => run.pauseReason === reason) ||
        current.state !== "RUNNING" ||
        current.idempotencyKey !== step.idempotencyKey ||
        run.pauseReason?.startsWith("RECONCILE_REQUIRED")
      )
        throw new DispatchAdmissionError("Paid dispatch is closed");
      if (AUDIO_KEYS.includes(current.key) && (await failedAudio(db, run.id)))
        throw new DispatchAdmissionError("Required audio input failed");
      await assertCriticRevision(db, tx, run, current);
      await assertPaidRunLimits(db, run, current.costMinor ?? 0, current.id);
      const { reservation, evidence } = await readAdmission(tx, context, current);
      if (reservation?.status !== "RESERVED" || reservation.expiresAt.getTime() <= Date.now())
        throw new DispatchAdmissionError("Paid dispatch reservation is inactive");
      if (evidence !== "pending") throw new ConflictException(submissionHold(step.id));
      const marked = await tx.providerRequest.updateMany({
        where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: "PENDING" },
        data: {
          errorCode: DISPATCHING,
          responseMetadata: { dispatched: true, costKnown: false },
        },
      });
      if (!marked.count) throw new ConflictException("Paid dispatch requires reconciliation");
      try {
        await assertLocked?.();
      } catch (cause) {
        throw new DispatchAdmissionError("Reference ownership lost before dispatch", { cause });
      }
      return { value: null, payload: { idempotencyKey: step.idempotencyKey }, stepId: step.id };
    });
  }

  public async jobReceipt(context: Context, step: Step): Promise<string | null> {
    return jobIdFromAdmission(await readAdmission(this.store.db, context, step));
  }

  public async recordJob(context: Context, step: Step, providerJobId: string): Promise<void> {
    const recorded = await this.store.db.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING },
      data: { responseMetadata: { dispatched: true, costKnown: false, providerJobId } },
    });
    if (recorded.count !== 1)
      throw new ConflictException("Provider job receipt could not be recorded");
  }

  public rollbackAdmission(context: Context, step: Step, budgetDenied = false): Promise<void> {
    return rollbackAdmission(this.store, this.usage, context, step, budgetDenied);
  }

  private async holdUnknown(context: Context, step: Step, cause: unknown): Promise<never> {
    const reason = submissionHold(step.id);
    await this.store.mutate(context, step.runId, "reconcile_required", async (db, run, tx) => {
      const marked = await tx.providerRequest.updateMany({
        where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING },
        data: { errorCode: OUTCOME_UNKNOWN },
      });
      if (marked.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
      if (run.pauseReason !== "EMERGENCY_STOP")
        await db.videoRun.updateMany({
          where: { id: run.id },
          data: { pauseReason: (await remainingSubmissionHold(db, tx, run)) ?? reason },
        });
      return { value: null, payload: { reason }, stepId: step.id };
    });
    throw new SubmissionOutcomeUnknown(reason, { cause });
  }

  public async finalizeRejected(
    context: Context,
    step: Step,
    failure: ProviderFailure,
  ): Promise<Event> {
    if (failure.dispatched && !(failure instanceof SubmissionRefused))
      throw new ConflictException("Provider dispatch was not ruled out");
    const reason =
      failure.http?.status === 403
        ? "PROVIDER_PERMISSION_DENIED"
        : failure.http?.status === 401
          ? "PROVIDER_UNAUTHENTICATED"
          : ["REFUSAL", "NEEDS_HUMAN"].includes(failure.kind)
            ? "PROVIDER_REFUSED"
            : `PROVIDER_${failure.kind}`;
    return finalizeFailed(
      this.store,
      this,
      context,
      step,
      reason,
      providerFailureMessage(failure.kind, failure.http),
      failure.dispatched,
      failure instanceof SubmissionRefused ? failure.providerJobId : null,
    );
  }

  public async finalizeJobFailure(context: Context, step: Step, reason: string): Promise<Event> {
    return finalizeFailed(
      this.store,
      this,
      context,
      step,
      reason,
      "Provider job ended unsuccessfully",
      true,
    );
  }

  public async settleFailedRequest(
    tx: Transaction,
    context: Context,
    step: Step,
    message: string,
    dispatched: boolean,
    cost: number,
    providerJobId = step.providerJobId,
    usage?: Record<string, unknown>,
  ): Promise<void> {
    if (!dispatched && !canConfirmRejection(await readAdmission(tx, context, step)))
      throw new ConflictException("Paid dispatch outcome changed");
    const code =
      usage !== undefined
        ? "PROVIDER_INVALID_OUTPUT"
        : dispatched
          ? "PROVIDER_JOB_FAILED"
          : "NOT_DISPATCHED";
    const updated = await tx.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: step.id,
        errorCode: dispatched ? { in: [DISPATCHING, OUTCOME_UNKNOWN] } : DISPATCHING,
      },
      data: {
        status: "FAILED",
        actualCost: dispatched ? null : 0,
        ...(usage !== undefined ? { usage: json(usage) } : {}),
        responseMetadata: {
          dispatched,
          costKnown: !dispatched,
          ...(providerJobId ? { providerJobId } : {}),
        },
        errorCode: code,
        errorMessage: message,
      },
    });
    if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
    const reservation = await tx.usageReservation.findFirstOrThrow({
      where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
    });
    if (dispatched) await this.usage.commit(context.workspaceId, reservation.id, cost, tx);
    else await this.usage.release(context.workspaceId, reservation.id, code, tx);
  }
  public async commitJob(
    tx: Transaction,
    context: Context,
    step: Step,
    actualMinor: number,
  ): Promise<void> {
    const reservation = await tx.usageReservation.findFirstOrThrow({
      where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
    });
    const updated = await tx.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: step.id,
        OR: [
          { errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN, BILLING_OVERAGE] } },
          { status: "SUCCEEDED", errorCode: null },
        ],
      },
      data: {
        status: "SUCCEEDED",
        actualCost: actualMinor / 100,
        responseMetadata: { dispatched: true, costKnown: true },
        errorCode: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
    await this.usage.commit(context.workspaceId, reservation.id, actualMinor, tx);
  }

  public async settleRejectedRequest(
    tx: Transaction,
    context: Context,
    step: Step,
    failure: ProviderFailure,
  ): Promise<void> {
    if (failure.dispatched) throw new ConflictException("Provider dispatch was not ruled out");
    await this.settleFailedRequest(
      tx,
      context,
      step,
      providerFailureMessage(failure.kind, failure.http),
      false,
      0,
    );
  }

  public async finish(
    context: Context,
    step: Step,
    dispatched: boolean,
    actualMinor: number,
    transaction?: Transaction,
  ): Promise<void> {
    const finish = async (tx: Transaction): Promise<void> => {
      const admission = await readAdmission(tx, context, step);
      const reservation = admission.reservation;
      if (!reservation) throw new ConflictException("Paid dispatch reservation is inactive");
      // The media adapter can also explicitly confirm rejection of an admitted dispatch.
      if (
        !dispatched &&
        !canConfirmRejection(admission) &&
        admission.evidence !== "pending" &&
        admission.evidence !== "released-nondispatch"
      )
        throw new ConflictException("Paid dispatch outcome changed");
      const updated = await tx.providerRequest.updateMany({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
          ...(dispatched
            ? { OR: [{ errorCode: DISPATCHING }, { status: "SUCCEEDED", errorCode: null }] }
            : { errorCode: admission.request?.errorCode ?? null }),
        },
        data: {
          status: dispatched ? "SUCCEEDED" : "FAILED",
          actualCost: dispatched ? actualMinor / 100 : 0,
          responseMetadata: { dispatched, costKnown: true },
          errorCode: dispatched ? null : "NOT_DISPATCHED",
        },
      });
      if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
      if (dispatched) await this.usage.commit(context.workspaceId, reservation.id, actualMinor, tx);
      else await this.usage.release(context.workspaceId, reservation.id, "NOT_DISPATCHED", tx);
    };
    if (transaction) await finish(transaction);
    else await this.store.db.$transaction(finish);
  }
}
