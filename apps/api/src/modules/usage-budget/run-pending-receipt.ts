import { ConflictException } from "@nestjs/common";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { z } from "zod";
import type { ShotBillingFailure, VideoReceipt } from "../orchestration/video-run.handlers.js";
import { transitionLocked } from "../runs/runs.store.js";
import type { Json, Run, Scoped, Step } from "../runs/runs.types.js";

export const PENDING_RECEIPT_CORRECTION = "PENDING_RECEIPT_CORRECTION";
export const pendingCorrectionWhere = {
  state: "SUCCEEDED" as const,
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

/** Persist the liability without reacquiring the budget lock that may have timed out. */
export async function deferCorrection(
  db: Scoped,
  run: Run,
  step: Step,
  report: NonNullable<ShotBillingFailure["report"]>,
  reason: string,
): Promise<{ value: null; payload: Json; stepId?: string; eventType?: string }> {
  if (report.providerId !== step.providerId || report.jobId !== step.providerJobId)
    throw new ConflictException("Provider job claim changed");
  const marker = pendingPrice.parse({
    code: PENDING_RECEIPT_CORRECTION,
    seconds: report.receipt.seconds,
    costMinor: report.receipt.costMinor,
    costBasis: report.receipt.costBasis,
    modelId: report.receipt.modelId,
    promptVersion: report.receipt.promptVersion,
    providerId: report.providerId,
    providerJobId: report.jobId,
  });
  const previous = pendingCorrection(step);
  if (!previous || marker.costMinor > previous.costMinor)
    await db.videoRunStep.updateMany({ where: { id: step.id }, data: { error: marker } });
  if (run.state === "GENERATING" && !run.pauseReason)
    return transitionLocked(db, run, "PAUSED_BUDGET", reason);
  const hold = correctionHold(step.id);
  if (!run.pauseReason)
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: hold } });
  return {
    value: null,
    eventType: "reconcile_required",
    stepId: step.id,
    payload: { reason: hold },
  };
}
