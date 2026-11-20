import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { UsageBudgetService } from "./usage-budget.service.js";
import type { PaidCallReservation } from "./usage-budget.types.js";
import { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Step } from "../runs/runs.types.js";

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
  ): Promise<PaidCallReservation> {
    const result = await this.usage.reserve(context.workspaceId, {
      channelId: run.channelId,
      idempotencyKey: `m08:${step.idempotencyKey}`,
      correlationId: step.id,
      category: "VIDEO_MEDIA",
      currency: "USD",
      amountMinor: amount,
      ttlMs: 86400000,
    });
    if (result.decision !== "RESERVED")
      throw new ServiceUnavailableException("Budget policy unavailable");
    if (result.replayed) throw new ConflictException("Paid dispatch requires reconciliation");
    await this.store.db.providerRequest.create({
      data: {
        workspaceId: context.workspaceId,
        channelId: run.channelId,
        correlationId: step.id,
        providerId: "v3-stub",
        capabilityId: "video",
        status: "FAILED",
        estimatedCost: amount / 100,
        currency: "USD",
        latencyMs: 0,
        dispatchedPrompt: "V3 deterministic stub",
        responseMetadata: { dispatched: false, costKnown: false },
        errorCode: "PENDING",
      },
    });
    return {
      workspaceId: context.workspaceId,
      reservationId: result.reservation.id,
      currency: "USD",
      estimateMinor: amount,
    };
  }
  public async dispatch<T>(context: Context, step: Step, call: () => Promise<T>): Promise<T> {
    try {
      await this.store.mutate(context, step.runId, "provider_dispatch", async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (
          run.state === "CANCELED" ||
          current.state !== "RUNNING" ||
          run.pauseReason?.startsWith("RECONCILE_REQUIRED")
        )
          throw new ConflictException("Paid dispatch is closed");
        const marked = await tx.providerRequest.updateMany({
          where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: "PENDING" },
          data: {
            errorCode: "VIDEO_RUN_DISPATCHING",
            responseMetadata: { dispatched: true, costKnown: false },
          },
        });
        if (!marked.count) throw new ConflictException("Paid dispatch requires reconciliation");
        return { value: null, payload: {}, stepId: step.id };
      });
    } catch (error) {
      const run = await this.store.get(context, step.runId);
      if (run.state === "CANCELED") await this.finish(context, step, false, 0);
      throw error;
    }
    try {
      return await call();
    } catch (error) {
      await this.store.db.providerRequest.updateMany({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
          errorCode: "VIDEO_RUN_DISPATCHING",
        },
        data: { errorCode: "VIDEO_RUN_OUTCOME_UNKNOWN" },
      });
      throw error;
    }
  }
  public async finish(
    context: Context,
    step: Step,
    dispatched: boolean,
    actualMinor: number,
  ): Promise<void> {
    const reservation = await this.store.db.usageReservation.findFirst({
      where: {
        workspaceId: context.workspaceId,
        idempotencyKey: `m08:${step.idempotencyKey}`,
      },
    });
    if (!reservation)
      throw new ConflictException("Paid reservation missing; reconciliation required");
    await this.store.db.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id },
      data: {
        status: dispatched ? "SUCCEEDED" : "FAILED",
        actualCost: dispatched ? actualMinor / 100 : 0,
        responseMetadata: { dispatched, costKnown: true },
        errorCode: dispatched ? null : "NOT_DISPATCHED",
      },
    });
    await this.usage.finishPaidCall(
      {
        workspaceId: context.workspaceId,
        reservationId: reservation.id,
        currency: "USD",
        estimateMinor: Number(reservation.amountMinor),
      },
      { dispatched, actualCost: actualMinor / 100, actualCurrency: "USD" },
    );
  }
}
