import { lockVideoJob } from "../usage-budget/video-job-evidence.js";
import { recordedShotPrice } from "../usage-budget/run-shot-receipt.js";
import { MissingVideoPricing } from "../scene-media/media-prices.js";
import {
  deferCorrection,
  needsReceiptMarker,
  pendingCorrection,
} from "../usage-budget/run-pending-receipt.js";
import { SETTLED_SHOTS, activeSubmissionHold } from "../runs/run-outcomes.js";
import { transitionLocked } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
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

function redundantFailure(step: Step, error: unknown): boolean {
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
  // A required keyframe can close its parent before the video was ever admitted.
  return !!step.providerId && SETTLED_SHOTS.some((state) => state === step.state);
}

export async function recordShotFailure(
  db: Scoped,
  tx: Transaction,
  run: Run,
  stepId: string,
  error: unknown,
  cause: unknown,
  reason: string,
): Promise<Awaited<ReturnType<typeof deferCorrection>> | undefined> {
  const media = error instanceof ShotMediaFailure ? error : undefined;
  const found = await db.videoRunStep.findFirst({
    where: {
      id: stepId,
      runId: run.id,
      key: { startsWith: "shot-" },
      ...(media && { providerId: media.providerId, providerJobId: media.providerJobId }),
    },
  });
  const attempt = found && (await lockVideoJob(tx, db, run, found.id));
  if (attempt && redundantFailure(attempt, error))
    return {
      value: null,
      eventType: "redundant_clip_discarded",
      stepId,
      payload: { replay: true, reason },
    };
  if (
    cause instanceof MissingVideoPricing &&
    attempt?.state === "WAITING_EXTERNAL" &&
    !attempt.error
  )
    await db.videoRunStep.updateMany({
      where: { id: attempt.id },
      data: { error: { code: MissingVideoPricing.code } },
    });
  const report = error instanceof ShotBillingFailure ? error.report : undefined;
  if (
    attempt &&
    report &&
    (pendingCorrection(attempt) || needsReceiptMarker(attempt, report.receipt))
  )
    return deferCorrection(db, run, attempt, report);
  if (media && !attempt) throw cause;
}
