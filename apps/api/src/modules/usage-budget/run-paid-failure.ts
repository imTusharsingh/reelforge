import { ConflictException } from "@nestjs/common";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction, Event } from "../runs/runs.types.js";
import type { RunPaidCalls } from "./run-paid.js";
import {
  PLANNING_MANIFEST_KEY,
  failSettledGeneration,
  clearResolvedSubmissionHold,
} from "../runs/run-outcomes.js";

export async function finalizeFailed(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  reason: string,
  message: string,
  dispatched: boolean,
  providerJobId: string | null = step.providerJobId,
): Promise<Event> {
  const result = await store.mutate(context, step.runId, "step_failed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({
      where: { id: step.id, runId: run.id },
    });
    if (current.state === "FAILED")
      return { value: null, payload: { replay: true }, stepId: step.id };
    if (
      current.state !== (step.providerJobId ? "WAITING_EXTERNAL" : "RUNNING") ||
      current.providerJobId !== step.providerJobId ||
      current.idempotencyKey !== step.idempotencyKey
    )
      throw new ConflictException("Dispatch claim changed");
    await paid.settleFailedRequest(tx, context, step, message, dispatched, providerJobId);
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: {
        state: "FAILED",
        providerJobId,
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
    await failRunIfSettled(db, tx, run, current, { code: reason, message });
    return {
      value: null,
      payload: { reason, message, releasedMinor: amount },
      stepId: step.id,
    };
  });
  return result.event;
}

async function failRunIfSettled(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  error: { code: string; message: string },
): Promise<void> {
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  if (step.key.startsWith("shot-")) {
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
