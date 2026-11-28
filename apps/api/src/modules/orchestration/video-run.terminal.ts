import type { FailedJobStatus, SubmissionRefused } from "@reelforge/ai-providers";
import { SETTLED_SHOTS } from "../runs/run-outcomes.js";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Step } from "../runs/runs.types.js";
import type { RunPaidCalls } from "../usage-budget/run-paid.js";
import {
  hasVideoDelivery,
  stageTerminalVideo,
  submissionBill,
  terminalVideo,
} from "../usage-budget/run-video-terminal.js";
import type { ShotBilling, VideoReceipt } from "./video-run.handlers.js";
import { settleVideoRefusal } from "./video-run.refusal.js";
import { ShotSpecSchema } from "@reelforge/contracts";

export function videoBilling(
  runs: RunsService,
  context: Context,
  step: Step,
  capture: (receipt: VideoReceipt) => Promise<Step>,
): ShotBilling {
  return {
    savedOutput: step.output,
    shot: ShotSpecSchema.parse(step.input),
    record: async (receipt, failure): Promise<void> => {
      if (failure) {
        const current = await stageTerminalVideo(
          runs.store,
          context,
          step,
          failure,
          step.providerJobId,
          receipt.costMinor,
        );
        if (
          terminalVideo(current) &&
          !hasVideoDelivery(current) &&
          !SETTLED_SHOTS.some((state) => state === current.state)
        )
          return;
      }
      await capture(receipt);
    },
  };
}

export async function observeSubmissionRefusal(
  runs: RunsService,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  error: SubmissionRefused,
): Promise<void> {
  const current = await stageTerminalVideo(
    runs.store,
    context,
    step,
    "refused",
    error.providerJobId,
    submissionBill(step, error.billedSeconds),
  );
  await settleObservedTerminal(runs, paid, context, current);
}

/** Only an observed terminal outcome can dispose of a video; a delivered clip always wins. */
export async function settleObservedTerminal(
  runs: RunsService,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  status?: FailedJobStatus,
): Promise<void> {
  const current = status
    ? await stageTerminalVideo(runs.store, context, step, status, step.providerJobId, null)
    : step;
  const seen = terminalVideo(current);
  if (!seen || hasVideoDelivery(current) || SETTLED_SHOTS.some((state) => state === current.state))
    return;
  if (seen.status === "refused")
    await settleVideoRefusal(
      runs,
      paid,
      context,
      current,
      current.state === "RUNNING" ? seen.providerJobId : undefined,
    );
  else {
    const event = await paid.finalizeJobFailure(context, current, "PROVIDER_FAILED");
    await runs.events?.publish(event);
  }
}
