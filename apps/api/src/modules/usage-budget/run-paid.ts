import { rollbackAdmission } from "./run-paid-admission.js";
import { z } from "zod";
import { ProviderFailure, providerFailureMessage } from "@reelforge/ai-providers";
import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { UsageBudgetService } from "./usage-budget.service.js";
import type { PaidCallReservation } from "./usage-budget.types.js";
import { RunsStore } from "../runs/runs.store.js";
import type { Context, Event, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";

import {
  DISPATCHING,
  OUTCOME_UNKNOWN,
  PLANNING_MANIFEST_KEY,
  failSettledGeneration,
  clearResolvedSubmissionHold,
} from "../runs/run-outcomes.js";

export class SubmissionOutcomeUnknown extends ConflictException {}

export class DispatchAdmissionError extends ConflictException {}

/** Keep M08/M18 logical keys, with the UUID step id as the ledger correlation id. */
@Injectable()
export class RunPaidCalls {
  public constructor(
    private readonly usage: UsageBudgetService,
    private readonly store: RunsStore,
  ) {}
  public async reserve(
    context: Context,
    run: Run,
    step: Step,
    amount: number,
    transaction?: Transaction,
  ): Promise<PaidCallReservation> {
    const result = await this.usage.reserve(
      context.workspaceId,
      {
        channelId: run.channelId,
        idempotencyKey: `m08:${step.idempotencyKey}`,
        correlationId: step.id,
        category: "VIDEO_MEDIA",
        currency: "USD",
        amountMinor: amount,
        ttlMs: 86400000,
      },
      transaction,
    );
    if (result.decision !== "RESERVED")
      throw new ServiceUnavailableException({
        code: result.reason,
        message: "Budget policy unavailable",
      });
    if (result.replayed) throw new ConflictException("Paid dispatch requires reconciliation");
    await this.recordReservation(transaction ?? this.store.db, context, run, step, amount);
    return {
      workspaceId: context.workspaceId,
      reservationId: result.reservation.id,
      currency: "USD",
      estimateMinor: amount,
    };
  }
  private async recordReservation(
    db: Transaction,
    context: Context,
    run: Run,
    step: Step,
    amount: number,
  ): Promise<void> {
    const request = {
      providerId: step.providerId ?? "v3-stub",
      capabilityId: "video",
      status: "FAILED" as const,
      estimatedCost: amount / 100,
      actualCost: null,
      currency: "USD",
      responseMetadata: { dispatched: false, costKnown: false },
      errorCode: "PENDING",
    };
    const rearmed = await db.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: step.id,
        errorCode: "ADMISSION_ROLLED_BACK",
      },
      data: request,
    });
    if (!rearmed.count)
      await db.providerRequest.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: run.channelId,
          correlationId: step.id,
          ...request,
        },
      });
  }
  public async dispatch<T>(
    context: Context,
    step: Step,
    call: () => Promise<T>,
    assertLocked?: () => Promise<void>,
  ): Promise<T> {
    await this.store
      .mutate(context, step.runId, "provider_dispatch", async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (
          ["CANCELED", "FAILED", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state) ||
          ["OPERATOR_ABANDONED", "EMERGENCY_STOP"].some((reason) => run.pauseReason === reason) ||
          current.state !== "RUNNING" ||
          current.idempotencyKey !== step.idempotencyKey ||
          run.pauseReason?.startsWith("RECONCILE_REQUIRED")
        )
          throw new DispatchAdmissionError("Paid dispatch is closed");
        const reservation = await tx.usageReservation.findFirst({
          where: {
            workspaceId: context.workspaceId,
            idempotencyKey: `m08:${step.idempotencyKey}`,
            status: "RESERVED",
            expiresAt: { gt: new Date() },
          },
        });
        if (!reservation) throw new DispatchAdmissionError("Paid dispatch reservation is inactive");
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
        return { value: null, payload: {}, stepId: step.id };
      })
      .catch(async (error: unknown) => {
        await this.rollbackAdmission(context, step);
        throw error;
      });
    // The durable dispatch marker protects the claims before invoking the provider.
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProviderFailure && !error.dispatched) throw error;
      return this.holdUnknown(context, step, error);
    }
  }

  public async jobReceipt(context: Context, step: Step): Promise<string | null> {
    const request = await this.store.db.providerRequest.findUnique({
      where: {
        workspaceId_correlationId: { workspaceId: context.workspaceId, correlationId: step.id },
      },
    });
    const receipt = z
      .object({ providerJobId: z.string().min(1) })
      .safeParse(request?.responseMetadata);
    return receipt.success ? receipt.data.providerJobId : null;
  }

  public async recordJob(context: Context, step: Step, providerJobId: string): Promise<void> {
    const recorded = await this.store.db.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING },
      data: { responseMetadata: { dispatched: true, costKnown: false, providerJobId } },
    });
    if (recorded.count !== 1)
      throw new ConflictException("Provider job receipt could not be recorded");
  }

  public rollbackAdmission(context: Context, step: Step): Promise<void> {
    return rollbackAdmission(this.store, this.usage, context, step);
  }

  private async holdUnknown(context: Context, step: Step, cause: unknown): Promise<never> {
    const reason = `RECONCILE_REQUIRED: provider submission outcome unknown (${step.id})`;
    await this.store.mutate(context, step.runId, "reconcile_required", async (db, run, tx) => {
      const marked = await tx.providerRequest.updateMany({
        where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING },
        data: { errorCode: OUTCOME_UNKNOWN },
      });
      if (marked.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
      await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: reason } });
      return { value: null, payload: { reason }, stepId: step.id };
    });
    throw new SubmissionOutcomeUnknown(reason, { cause });
  }

  public async finalizeRejected(
    context: Context,
    step: Step,
    failure: ProviderFailure,
  ): Promise<Event> {
    if (failure.dispatched) throw new ConflictException("Provider dispatch was not ruled out");
    const reason = ["REFUSAL", "NEEDS_HUMAN"].includes(failure.kind)
      ? "PROVIDER_REFUSED"
      : `PROVIDER_${failure.kind}`;
    return this.finalizeFailed(
      context,
      step,
      reason,
      providerFailureMessage(failure.kind, failure.http),
      false,
    );
  }

  public async finalizeJobFailure(context: Context, step: Step, reason: string): Promise<Event> {
    return this.finalizeFailed(context, step, reason, "Provider job ended unsuccessfully", true);
  }

  private async finalizeFailed(
    context: Context,
    step: Step,
    reason: string,
    message: string,
    dispatched: boolean,
  ): Promise<Event> {
    const result = await this.store.mutate(
      context,
      step.runId,
      "step_failed",
      async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({
          where: { id: step.id, runId: run.id },
        });
        if (current.state === "FAILED")
          return { value: null, payload: { replay: true }, stepId: step.id };
        if (
          current.state !== (dispatched ? "WAITING_EXTERNAL" : "RUNNING") ||
          Boolean(current.providerJobId) !== dispatched
        )
          throw new ConflictException("Dispatch claim changed");
        await this.settleFailedRequest(tx, context, step, message, dispatched);
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "FAILED",
            costMinor: dispatched ? current.costMinor : 0,
            finishedAt: new Date(),
            error: { code: reason, message },
          },
        });
        const amount = current.costMinor ?? 0;
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id },
            data: {
              reservedMinor: budget.reservedMinor - amount,
              spentMinor: budget.spentMinor + (dispatched ? amount : 0),
              revision: budget.revision + 1,
            },
          });
        await this.failRunIfSettled(db, tx, run, current, { code: reason, message });
        return {
          value: null,
          payload: { reason, message, releasedMinor: amount },
          stepId: step.id,
        };
      },
    );
    return result.event;
  }

  private async failRunIfSettled(
    db: Scoped,
    tx: Transaction,
    run: Run,
    step: Step,
    error: { code: string; message: string },
  ): Promise<void> {
    if (step.key.startsWith("shot-")) {
      const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
      await failSettledGeneration(db, { ...run, pauseReason });
    } else if (step.key.startsWith("media:text:") && run.state !== "CANCELED") {
      await db.videoRunStep.updateMany({
        where: {
          runId: run.id,
          key: { in: [run.state, PLANNING_MANIFEST_KEY] },
          state: "RUNNING",
        },
        data: { state: "FAILED", finishedAt: new Date(), error },
      });
      await db.videoRun.updateMany({
        where: { id: run.id },
        data: {
          state: "FAILED",
          pauseReason: error.code,
          ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
        },
      });
    }
  }

  private async settleFailedRequest(
    tx: Transaction,
    context: Context,
    step: Step,
    message: string,
    dispatched: boolean,
  ): Promise<void> {
    const code = dispatched ? "PROVIDER_JOB_FAILED" : "NOT_DISPATCHED";
    const updated = await tx.providerRequest.updateMany({
      where: {
        workspaceId: context.workspaceId,
        correlationId: step.id,
        errorCode: dispatched ? { in: [DISPATCHING, OUTCOME_UNKNOWN] } : DISPATCHING,
      },
      data: {
        status: "FAILED",
        actualCost: dispatched ? null : 0,
        responseMetadata: { dispatched, costKnown: !dispatched },
        errorCode: code,
        errorMessage: message,
      },
    });
    if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
    const reservation = await tx.usageReservation.findFirstOrThrow({
      where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
    });
    if (dispatched)
      await this.usage.commit(context.workspaceId, reservation.id, step.costMinor ?? 0, tx);
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
          { errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN] } },
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
      const reservation = await tx.usageReservation.findFirstOrThrow({
        where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
      });
      const updated = await tx.providerRequest.updateMany({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
          ...(dispatched
            ? { OR: [{ errorCode: DISPATCHING }, { status: "SUCCEEDED", errorCode: null }] }
            : { errorCode: { in: [DISPATCHING, "PENDING", "RUN_CANCELED", "NOT_DISPATCHED"] } }),
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
