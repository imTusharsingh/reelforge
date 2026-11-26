import { recordedShotPrice } from "../usage-budget/run-shot-receipt.js";
import { pendingCorrection } from "../usage-budget/run-pending-receipt.js";
import { SETTLED_SHOTS, activeSubmissionHold } from "../runs/run-outcomes.js";
import { transitionLocked } from "../runs/runs.store.js";
import type { Context, Step } from "../runs/runs.types.js";
import { reconcilePricedReceipt } from "../usage-budget/run-billing.js";
import type { RunPaidCalls } from "../usage-budget/run-paid.js";
import { ShotBillingFailure, ShotMediaFailure } from "./video-run.handlers.js";
import type { RunsService } from "../runs/runs.service.js";

export async function resumeAfterCorrection(
  runs: RunsService,
  context: Context,
  runId: string,
): Promise<void> {
  const result = await runs.store.mutate(
    context,
    runId,
    "billing_recovered",
    async (db, run, tx) => {
      if (
        run.state !== "PAUSED_BUDGET" ||
        run.pauseReason !== null ||
        (await activeSubmissionHold(db, tx, run))
      )
        return { value: false, payload: { replay: true } };
      await transitionLocked(db, run, "GENERATING", null);
      return { value: true, payload: { from: "PAUSED_BUDGET", to: "GENERATING" } };
    },
  );
  if (result.value) await runs.events?.publish(result.event);
  const run = await runs.store.get(context, runId);
  if (!run.pauseReason && ["GENERATING", "ASSEMBLING", "CRITIC"].includes(run.state))
    await runs.enqueue(context, run);
}

export async function reconcileBilling(
  runs: RunsService,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
): Promise<null> {
  await reconcilePricedReceipt(runs.store, paid, context, step).catch((cause: unknown) => {
    throw new ShotMediaFailure(step.providerId!, step.providerJobId!, cause);
  });
  const run = await runs.store.get(context, step.runId);
  if (run.state === "PAUSED_BUDGET" && !run.pauseReason)
    await resumeAfterCorrection(runs, context, run.id);
  else if (run.state === "GENERATING" && !run.pauseReason) await runs.enqueue(context, run);
  return null;
}

export function redundantFailure(step: Step, error: unknown): boolean {
  if (error instanceof ShotBillingFailure) {
    const report = error.report;
    // A settled job can still owe a new charge. Only discard proven receipt replays.
    return (
      !!report &&
      step.state === "SUCCEEDED" &&
      report.providerId === step.providerId &&
      report.jobId === step.providerJobId &&
      !pendingCorrection(step) &&
      recordedShotPrice(step, report.receipt)
    );
  }
  if (error instanceof ShotMediaFailure) return step.state === "SUCCEEDED";
  return SETTLED_SHOTS.some((state) => state === step.state);
}
