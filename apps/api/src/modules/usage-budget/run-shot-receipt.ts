import { ConflictException } from "@nestjs/common";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { z } from "zod";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { ArtifactSchema, json, type Json, type Scoped, type Step } from "../runs/runs.types.js";
import { isBillingHold, type Admission } from "./run-admission-state.js";

const ReceiptBudgetSchema = z.object({
  admittedMinor: z.number().int().nonnegative(),
  bufferMinor: z.number().int().nonnegative(),
  estimateMinor: z.number().int().nonnegative().optional(),
});

export type ReceiptBudget = z.infer<typeof ReceiptBudgetSchema>;

export function readReceiptBudget(output: Json | null): ReceiptBudget | undefined {
  if (!output || typeof output !== "object" || !("receiptBudget" in output)) return undefined;
  return ReceiptBudgetSchema.parse(output.receiptBudget);
}

export function withReceiptBudget(output: Json, budget: ReceiptBudget): Json {
  const fields = z.record(z.string(), z.unknown()).parse(output);
  return json({ ...fields, receiptBudget: budget });
}

export const pricedOutput = z.object({
  receipt: z.object({
    providerJobId: z.string().min(1),
    costMinor: z.int().nonnegative(),
    costBasis: MediaReceiptSchema.shape.costBasis.removeDefault().optional(),
  }),
});
export function awaitingBilling(step: Step): boolean {
  return isBillingHold(step.error);
}

const pendingOutput = z.object({
  pendingMedia: z
    .object({
      objectKey: z.string(),
      checksumSha256: z.string(),
      byteSize: z.number(),
      mimeType: z.string(),
      durationSeconds: z.number(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      billedSeconds: z.number().nullable(),
    })
    .nullable(),
  receipt: pricedOutput.shape.receipt.extend({
    key: z.string(),
    providerId: z.string(),
    seconds: z.number(),
    providerDurationSeconds: z.number().nullable(),
    modelId: z.string(),
    promptVersion: z.string(),
  }),
});

export function pendingShotMedia(step: Step): z.infer<typeof pendingOutput> | null {
  if (!step.output || typeof step.output !== "object" || !("pendingMedia" in step.output))
    return null;
  const saved = pendingOutput.parse(step.output);
  if (
    saved.receipt.providerJobId !== step.providerJobId ||
    saved.receipt.providerId !== step.providerId
  )
    throw new ConflictException("Stored receipt does not match shot");
  return saved;
}

type StoredPrice = z.infer<typeof pricedOutput.shape.receipt>;

/** Unmarked historical prices can include provider reports. Preserve them on ambiguous replays. */
function replacesPrice(previous: StoredPrice | undefined, price: VideoReceipt): boolean {
  if (!previous) return true;
  return (
    price.costBasis === "BILLED" &&
    (previous.costBasis === "RESERVATION" || price.costMinor > previous.costMinor)
  );
}

const deliveredOutput = z
  .object({
    receipt: pricedOutput.shape.receipt.extend({ providerId: z.string() }).passthrough(),
    storageArtifacts: z.array(ArtifactSchema.passthrough()).min(1),
  })
  .passthrough();

/** Delivered overages already have a winning artifact while their step is still open. */
export function deliveredShot(step: Step): z.infer<typeof deliveredOutput> | null {
  if (
    step.state !== "SUCCEEDED" &&
    !(step.output && typeof step.output === "object" && "storageArtifacts" in step.output)
  )
    return null;
  const final = deliveredOutput.parse(step.output);
  if (
    final.receipt.providerJobId !== step.providerJobId ||
    final.receipt.providerId !== step.providerId
  )
    throw new ConflictException("Stored receipt does not match shot");
  return final;
}

export function mergeShotReceipt(
  step: Step,
  receipt: VideoReceipt,
): { output: Json; cost: number; previousCost: number | undefined; priceChanged: boolean } | null {
  const pending = pendingShotMedia(step);
  const { media, ...price } = receipt;
  const final = deliveredShot(step);
  if (final) {
    if (!replacesPrice(final.receipt, receipt)) return null;
    return {
      priceChanged: true,
      previousCost: final.receipt.costMinor,
      cost: price.costMinor,
      output: json({
        ...final,
        receipt: {
          ...final.receipt,
          costMinor: price.costMinor,
          costBasis: price.costBasis,
          seconds: price.seconds,
          modelId: price.modelId,
          promptVersion: price.promptVersion,
        },
      }),
    };
  }
  const priceChanged = replacesPrice(pending?.receipt, receipt);
  if (!priceChanged && !media) return null;
  const pendingMedia = media ?? pending?.pendingMedia ?? null;
  const output = pendingOutput.parse({
    pendingMedia,
    receipt: {
      ...(priceChanged ? price : pending?.receipt),
      key: step.key,
      providerId: step.providerId,
      providerJobId: step.providerJobId,
      providerDurationSeconds: pendingMedia?.durationSeconds ?? null,
    },
  });
  return {
    priceChanged,
    previousCost: pending?.receipt.costMinor,
    cost: output.receipt.costMinor,
    output: json({ ...admissionFields(step), ...output }),
  };
}

export function admissionFields(step: Step): Record<string, unknown> {
  const { receiptBudget, videoPricing, refusalRewrite } = z
    .record(z.string(), z.unknown())
    .parse(step.output ?? {});
  return {
    ...(receiptBudget !== undefined && { receiptBudget }),
    ...(videoPricing !== undefined && { videoPricing }),
    ...(refusalRewrite !== undefined && { refusalRewrite }),
  };
}

export function correctionPayload(step: Step, receipt: VideoReceipt, refusedBilling = false): Json {
  return {
    key: step.key,
    providerId: step.providerId,
    providerJobId: step.providerJobId,
    costBasis: receipt.costBasis,
    seconds: receipt.seconds,
    previousCostMinor: step.costMinor,
    costMinor: receipt.costMinor,
    adjustmentMinor: receipt.costMinor - step.costMinor!,
    ...(refusedBilling && { refusedBilling: true }),
  };
}

export function terminalBilledShot(step: Step): boolean {
  return (
    step.key.startsWith("shot-") &&
    ["SKIPPED", "FAILED"].includes(step.state) &&
    z.object({ code: z.enum(["PROVIDER_REFUSED", "PROVIDER_FAILED"]) }).safeParse(step.error)
      .success
  );
}

export function requireReceiptAttempt(current: Step, observed: Step): void {
  if (
    !observed.providerJobId ||
    current.providerJobId !== observed.providerJobId ||
    current.providerId !== observed.providerId ||
    current.idempotencyKey !== observed.idempotencyKey ||
    (!["SUCCEEDED", "WAITING_EXTERNAL"].includes(current.state) && !terminalBilledShot(current))
  )
    throw new ConflictException("Provider job claim changed");
}

export function recordedShotPrice(step: Step, receipt: VideoReceipt): boolean {
  const saved = pricedOutput.safeParse(step.output);
  return (
    saved.success &&
    saved.data.receipt.providerJobId === step.providerJobId &&
    saved.data.receipt.costMinor === step.costMinor &&
    !replacesPrice(saved.data.receipt, receipt)
  );
}

/** The caller holds the run lock for the ledger, step and envelope writes. */
export async function adjustEnvelope(
  db: Scoped,
  runId: string,
  delta: { spentMinor: number; reservedMinor: number; overageMinor: number },
): Promise<void> {
  const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId } });
  const spentMinor = budget.spentMinor + delta.spentMinor;
  const reservedMinor = budget.reservedMinor + delta.reservedMinor;
  // Preserve shot overruns and cover any shortfall after siblings reuse released funds.
  // Admission still compares gross spent + reserved against the cap.
  const overageMinor = Math.max(
    budget.overageMinor + delta.overageMinor,
    spentMinor + reservedMinor - budget.hardCapMinor,
  );
  const updated = await db.budgetEnvelope.updateMany({
    where: { id: budget.id, revision: budget.revision },
    data: {
      reservedMinor,
      spentMinor,
      overageMinor,
      revision: budget.revision + 1,
    },
  });
  if (updated.count !== 1) throw new ConflictException("Billing envelope changed");
}

export function importedShotEstimate(
  { request, reservation }: Admission,
  previous: number | undefined,
): boolean {
  const estimate = z
    .object({ legacyEstimateMinor: z.number().int() })
    .safeParse(request?.responseMetadata).data;
  return (
    !!request &&
    request.status === "SUCCEEDED" &&
    request.errorCode === null &&
    request.actualCost === null &&
    previous !== undefined &&
    estimate?.legacyEstimateMinor === previous &&
    reservation?.committedMinor != null &&
    reservation.committedMinor <= BigInt(previous)
  );
}
