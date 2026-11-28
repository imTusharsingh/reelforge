import { terminalVideoWhere } from "./run-video-terminal.js";
import { ConflictException } from "@nestjs/common";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { z } from "zod";
import type { ShotBillingFailure, VideoReceipt } from "../orchestration/video-run.handlers.js";
import { transitionLocked } from "../runs/runs.store.js";
import type { Context, Json, Run, Scoped, Step } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import { videoPricingSchema } from "../scene-media/media-prices.js";
import { pendingShotMedia, pricedOutput, terminalBilledShot } from "./run-shot-receipt.js";

export const PENDING_RECEIPT_CORRECTION = "PENDING_RECEIPT_CORRECTION";
const pendingRefusedBillWhere = {
  state: { in: ["SKIPPED", "FAILED"] as ("SKIPPED" | "FAILED")[] },
  OR: [
    { error: { path: ["code"], equals: "PROVIDER_REFUSED" } },
    { error: { path: ["code"], equals: "PROVIDER_FAILED" } },
  ],
  output: { path: ["pendingRefusalBill", "code"], equals: PENDING_RECEIPT_CORRECTION },
};
export const pendingCorrectionWhere = {
  OR: [
    {
      state: { in: ["SUCCEEDED", "WAITING_EXTERNAL"] as ("SUCCEEDED" | "WAITING_EXTERNAL")[] },
      error: { path: ["code"], equals: PENDING_RECEIPT_CORRECTION },
    },
    pendingRefusedBillWhere,
  ],
};

export async function shouldCheckShotBoundary(
  db: Scoped,
  run: Run,
  stepId: string,
): Promise<boolean> {
  return (
    run.state === "GENERATING" &&
    !run.pauseReason &&
    !(await db.videoRunStep.findFirst({
      where: { id: stepId, runId: run.id, OR: [pendingRefusedBillWhere, terminalVideoWhere] },
      select: { id: true },
    }))
  );
}

export function pendingCorrectionJobs(
  db: Scoped,
): Promise<{ id: string; runId: string; run: { revision: number } }[]> {
  return db.videoRunStep.findMany({
    where: { OR: [pendingCorrectionWhere, terminalVideoWhere], run: { state: { not: "FAILED" } } },
    select: { id: true, runId: true, run: { select: { revision: true } } },
  });
}

const receiptFields = MediaReceiptSchema.shape;
const pendingPrice = z
  .object({
    providerId: receiptFields.providerId,
    providerJobId: receiptFields.providerJobId.unwrap(),
    seconds: receiptFields.seconds,
    costMinor: receiptFields.costMinor,
    modelId: receiptFields.modelId,
    promptVersion: receiptFields.promptVersion,
    code: z.literal(PENDING_RECEIPT_CORRECTION),
    costBasis: z.literal("BILLED"),
  })
  .strict();

export function pendingCorrection(step: Step): VideoReceipt | null {
  const marker = terminalBilledShot(step)
    ? z.object({ pendingRefusalBill: z.unknown().optional() }).parse(step.output ?? {})
        .pendingRefusalBill
    : step.error;
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

/** A price-only marker must not discard a later delivery of the same provider job. */
export function highestObservedReceipt(
  pending: VideoReceipt | null,
  received: VideoReceipt,
): VideoReceipt {
  if (!pending || (received.costBasis === "BILLED" && received.costMinor > pending.costMinor))
    return received;
  return {
    ...pending,
    media: received.media,
    providerDurationSeconds: received.providerDurationSeconds,
  };
}

function recordedBilledMinor(step: Step): number | undefined {
  const pending = pendingCorrection(step);
  if (pending) return pending.costMinor;
  const media = pendingShotMedia(step);
  if (media?.receipt.costBasis === "BILLED") return media.receipt.costMinor;
  const saved = pricedOutput.safeParse(step.output);
  return saved.success && saved.data.receipt.costBasis !== "RESERVATION"
    ? saved.data.receipt.costMinor
    : undefined;
}

export function needsReceiptMarker(step: Step, receipt: VideoReceipt): boolean {
  if (receipt.costBasis !== "BILLED") return false;
  const previous = recordedBilledMinor(step);
  return previous === undefined || receipt.costMinor > previous;
}

export function isReceiptCorrection(step: Step, receipt: VideoReceipt): boolean {
  const previous = recordedBilledMinor(step);
  return receipt.costBasis === "BILLED" && previous !== undefined && receipt.costMinor > previous;
}

export function carryRefusalBill(step: Step): { output: Json } | Record<never, never> {
  const pending = pendingCorrection(step);
  if (!pending) return {};
  const output = z.record(z.string(), z.json()).parse(step.output ?? {});
  return { output: { ...output, pendingRefusalBill: receiptMarker(step, pending) } };
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

/** Persist the first or higher billed observation before any budget-row correction can time out. */
export async function persistPendingCorrection(
  store: RunsStore,
  context: Context,
  observed: Step,
  receipt: VideoReceipt,
): Promise<void> {
  if (receipt.costBasis !== "BILLED") return;
  const marker = receiptMarker(observed, receipt);
  await store.mutate(context, observed.runId, "receipt_observed", async (db, run) => {
    const current = await db.videoRunStep.findFirstOrThrow({
      where: { id: observed.id, runId: run.id },
    });
    if (
      current.idempotencyKey !== observed.idempotencyKey ||
      current.providerId !== marker.providerId ||
      current.providerJobId !== marker.providerJobId ||
      (!["WAITING_EXTERNAL", "SUCCEEDED"].includes(current.state) && !terminalBilledShot(current))
    )
      throw new ConflictException("Provider job claim changed");
    if (!needsReceiptMarker(current, receipt)) return { value: null, payload: { replay: true } };
    if (terminalBilledShot(current)) {
      await saveRefusalBill(db, current, marker);
      return { value: null, payload: { costMinor: marker.costMinor }, stepId: current.id };
    }
    // An older worker can replace the output while a priced fetch is in flight.
    // Keep the admission terms used for this observation across a later billing timeout.
    const fields = z.record(z.string(), z.json()).parse(current.output ?? {});
    const observedTerms = z.object({ videoPricing: videoPricingSchema }).safeParse(observed.output);
    await db.videoRunStep.updateMany({
      where: { id: current.id, providerId: marker.providerId, providerJobId: marker.providerJobId },
      data: {
        error: marker,
        ...(fields.videoPricing === undefined &&
          observedTerms.success && {
            output: { ...fields, videoPricing: observedTerms.data.videoPricing },
          }),
      },
    });
    return {
      value: null,
      payload: { costMinor: marker.costMinor },
      stepId: current.id,
    };
  });
}

async function saveRefusalBill(
  db: Scoped,
  step: Step,
  marker: z.infer<typeof pendingPrice>,
): Promise<void> {
  const output = z.record(z.string(), z.json()).parse(step.output ?? {});
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: { output: { ...output, pendingRefusalBill: marker } },
  });
}

/** Hold the run without reacquiring the budget lock that may have timed out. */
export async function deferCorrection(
  db: Scoped,
  run: Run,
  step: Step,
  report: NonNullable<ShotBillingFailure["report"]>,
): Promise<{ value: null; payload: Json; stepId?: string; eventType?: string }> {
  if (report.providerId !== step.providerId || report.jobId !== step.providerJobId)
    throw new ConflictException("Provider job claim changed");
  if (needsReceiptMarker(step, report.receipt)) {
    const marker = receiptMarker(step, report.receipt);
    if (terminalBilledShot(step)) await saveRefusalBill(db, step, marker);
    else await db.videoRunStep.updateMany({ where: { id: step.id }, data: { error: marker } });
  }
  const hold = correctionHold(step.id);
  if (!terminalBilledShot(step) && run.state === "GENERATING" && !run.pauseReason)
    return transitionLocked(db, run, "PAUSED_BUDGET", hold);
  if (!terminalBilledShot(step) && !run.pauseReason)
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: hold } });
  return {
    value: null,
    eventType: "reconcile_required",
    stepId: step.id,
    payload: { reason: hold },
  };
}
