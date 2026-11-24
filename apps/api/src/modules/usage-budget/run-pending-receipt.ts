import { ConflictException } from "@nestjs/common";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { z } from "zod";
import type { ShotBillingFailure, VideoReceipt } from "../orchestration/video-run.handlers.js";
import { transitionLocked } from "../runs/runs.store.js";
import type { Context, Json, Run, Scoped, Step } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";

export const PENDING_RECEIPT_CORRECTION = "PENDING_RECEIPT_CORRECTION";
export const pendingCorrectionWhere = {
  state: { in: ["SUCCEEDED", "WAITING_EXTERNAL"] as ("SUCCEEDED" | "WAITING_EXTERNAL")[] },
  error: { path: ["code"], equals: PENDING_RECEIPT_CORRECTION },
};

const pendingPrice = MediaReceiptSchema.pick({
  providerId: true,
  providerJobId: true,
  seconds: true,
  costMinor: true,
  modelId: true,
  promptVersion: true,
}).extend({ code: z.literal(PENDING_RECEIPT_CORRECTION), costBasis: z.literal("BILLED") });

export function pendingCorrection(step: Step): VideoReceipt | null {
  const marker = step.error;
  if (
    !marker ||
    typeof marker !== "object" ||
    !("code" in marker) ||
    marker.code !== PENDING_RECEIPT_CORRECTION
  )
    return null;
  const price = pendingPrice.parse(marker);
  if (price.providerJobId !== step.providerJobId || price.providerId !== step.providerId)
    throw new ConflictException("Pending receipt does not match settled shot");
  return { ...price, providerDurationSeconds: null, media: null };
}

export function correctionHold(stepId: string): string {
  return `RECONCILE_REQUIRED: pending receipt correction (${stepId})`;
}

function receiptMarker(step: Step, receipt: VideoReceipt): z.infer<typeof pendingPrice> {
  if (!step.providerId || !step.providerJobId)
    throw new ConflictException("Provider job claim changed");
  return pendingPrice.parse({
    code: PENDING_RECEIPT_CORRECTION,
    seconds: receipt.seconds,
    costMinor: receipt.costMinor,
    costBasis: receipt.costBasis,
    modelId: receipt.modelId,
    promptVersion: receipt.promptVersion,
    providerId: step.providerId,
    providerJobId: step.providerJobId,
  });
}

/** Commit an over-reservation receipt before any budget-row correction can time out. */
export async function persistPendingCorrection(
  store: RunsStore,
  context: Context,
  observed: Step,
  receipt: VideoReceipt,
): Promise<void> {
  if (receipt.costBasis !== "BILLED") return;
  const marker = receiptMarker(observed, receipt);
  if (marker.costMinor <= (observed.costMinor ?? 0) && !pendingCorrection(observed)) return;
  await store.mutate(context, observed.runId, "receipt_observed", async (db, run) => {
    const current = await db.videoRunStep.findFirstOrThrow({
      where: { id: observed.id, runId: run.id },
    });
    if (
      current.providerId !== marker.providerId ||
      current.providerJobId !== marker.providerJobId ||
      !["WAITING_EXTERNAL", "SUCCEEDED"].includes(current.state)
    )
      throw new ConflictException("Provider job claim changed");
    const previous = pendingCorrection(current);
    if (previous?.costMinor !== undefined && previous.costMinor >= marker.costMinor)
      return { value: null, payload: { replay: true } };
    if (!previous && marker.costMinor <= (current.costMinor ?? 0))
      return { value: null, payload: { replay: true } };
    await db.videoRunStep.updateMany({
      where: { id: current.id, providerId: marker.providerId, providerJobId: marker.providerJobId },
      data: { error: marker },
    });
    return {
      value: null,
      payload: { costMinor: marker.costMinor },
      stepId: current.id,
    };
  });
}

/** Persist the liability without reacquiring the budget lock that may have timed out. */
export async function deferCorrection(
  db: Scoped,
  run: Run,
  step: Step,
  report: NonNullable<ShotBillingFailure["report"]>,
): Promise<{ value: null; payload: Json; stepId?: string; eventType?: string }> {
  if (report.providerId !== step.providerId || report.jobId !== step.providerJobId)
    throw new ConflictException("Provider job claim changed");
  const marker = receiptMarker(step, report.receipt);
  const previous = pendingCorrection(step);
  if (!previous || marker.costMinor > previous.costMinor)
    await db.videoRunStep.updateMany({ where: { id: step.id }, data: { error: marker } });
  const hold = correctionHold(step.id);
  if (run.state === "GENERATING" && !run.pauseReason)
    return transitionLocked(db, run, "PAUSED_BUDGET", hold);
  if (!run.pauseReason)
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: hold } });
  return {
    value: null,
    eventType: "reconcile_required",
    stepId: step.id,
    payload: { reason: hold },
  };
}
