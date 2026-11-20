import { randomUUID } from "node:crypto";
import { clearResolvedSubmissionHold } from "../runs/run-outcomes.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Step, Transaction } from "../runs/runs.types.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

export async function rollbackAdmission(
  store: RunsStore,
  usage: UsageBudgetService,
  context: Context,
  step: Step,
): Promise<void> {
  await store.mutate(context, step.runId, "dispatch_released", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    const unchanged =
      current.idempotencyKey === step.idempotencyKey &&
      current.state === "RUNNING" &&
      !current.providerJobId;
    if (!unchanged) return { value: null, payload: { replay: true } };
    const where = { workspaceId: context.workspaceId, correlationId: step.id };
    const request = await tx.providerRequest.findUnique({
      where: { workspaceId_correlationId: where },
    });
    if (request && request.errorCode !== "PENDING" && request.errorCode !== "ADMISSION_ROLLED_BACK")
      return { value: null, payload: { replay: true } };
    await releaseReservation(tx, usage, context, step);
    await tx.providerRequest.updateMany({
      where: { ...where, errorCode: "PENDING" },
      data: {
        errorCode: "ADMISSION_ROLLED_BACK",
        actualCost: 0,
        responseMetadata: { dispatched: false, costKnown: true },
      },
    });
    const shot = step.key.startsWith("shot-");
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: shot
        ? {
            state: "PENDING",
            costMinor: null,
            providerId: null,
            startedAt: null,
            idempotencyKey: `${step.id}:admission:${randomUUID()}`,
          }
        : { state: "CANCELLED", finishedAt: new Date(), output: { closedBy: "NOT_DISPATCHED" } },
    });
    const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
    const amount = current.costMinor ?? 0;
    if (budget && amount)
      await db.budgetEnvelope.updateMany({
        where: { id: budget.id },
        data: { reservedMinor: budget.reservedMinor - amount, revision: budget.revision + 1 },
      });
    await clearResolvedSubmissionHold(db, tx, run, step.id);
    return {
      value: null,
      payload: { amountMinor: amount, reason: "NOT_DISPATCHED" },
      stepId: step.id,
    };
  });
}

async function releaseReservation(
  tx: Transaction,
  usage: UsageBudgetService,
  context: Context,
  step: Step,
): Promise<void> {
  const reservation = await tx.usageReservation.findFirst({
    where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
  });
  if (reservation) {
    await usage.release(context.workspaceId, reservation.id, "NOT_DISPATCHED", tx);
    // Keep the released reservation while freeing the unique current-attempt correlation.
    await tx.usageReservation.update({
      where: { id: reservation.id },
      data: { correlationId: null },
    });
  }
}
