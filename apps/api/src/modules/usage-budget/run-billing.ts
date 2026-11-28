import {
  correctionHold,
  pendingCorrection,
  highestObservedReceipt,
} from "./run-pending-receipt.js";
import { captureRefusedBill } from "./provider-charge-credit.js";
import { invalidateAssemblyManifests } from "../composition/assembly-receipts.js";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { pinnedBudget } from "./run-envelope.js";
import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import {
  billingHold,
  recordShotBillingHold,
  SETTLED_SHOTS,
  clearResolvedSubmissionHold,
  failSettledGeneration,
} from "../runs/run-outcomes.js";
import {
  json,
  type Artifact,
  type Context,
  type Json,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";
import {
  BILLING_OVERAGE,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  readAdmission,
  type Admission,
} from "./run-admission-state.js";
import type { RunPaidCalls } from "./run-paid.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import {
  adjustEnvelope,
  admissionFields,
  importedShotEstimate,
  awaitingBilling,
  correctionPayload,
  deliveredShot,
  requireReceiptAttempt,
  terminalBilledShot,
  mergeShotReceipt,
  pendingShotMedia,
  readReceiptBudget,
  withReceiptBudget,
} from "./run-shot-receipt.js";
import type { ReceiptBudget } from "./run-shot-receipt.js";

function receiptReservation(
  run: Run,
  step: Step,
  { request, reservation }: Admission,
): NonNullable<Admission["reservation"]> {
  const priorJob = z.object({ providerJobId: z.string() }).safeParse(request?.responseMetadata);
  if (priorJob.success && priorJob.data.providerJobId !== step.providerJobId)
    throw new ConflictException("Provider job receipt changed");
  if (
    !reservation ||
    reservation.correlationId !== step.id ||
    reservation.channelId !== run.channelId ||
    !step.providerJobId ||
    !step.providerId ||
    reservation.currency !== "USD" ||
    (request && (request.currency !== reservation.currency || request.channelId !== run.channelId))
  )
    throw new ConflictException("Billing receipt does not match the paid attempt");
  return reservation;
}

function matchesCommit({ request, reservation }: Admission, amount: bigint): boolean {
  return (
    request?.status === "SUCCEEDED" &&
    request.errorCode === null &&
    request.actualCost?.mul(100).equals(amount.toString()) === true &&
    reservation?.committedMinor === amount
  );
}

const samePricedRequest = (
  request: Admission["request"],
  errorCode: string | null,
  cost: number,
): boolean =>
  request?.status === "SUCCEEDED" &&
  request.errorCode === errorCode &&
  request.actualCost?.mul(100).equals(cost.toString()) === true;

/** Older workers could commit the fetched price before attaching the clip. */
function verifyLegacyPayment(
  claim: Admission,
  reservation: NonNullable<Admission["reservation"]>,
  receipt: VideoReceipt,
): boolean {
  const cost = BigInt(receipt.costMinor);
  if (matchesCommit(claim, cost)) return true;
  const committed = reservation.committedMinor;
  // A lower preliminary report can proceed to fetch. Keep the payment intact until verified.
  if (!receipt.media && committed !== null && committed > cost && matchesCommit(claim, committed))
    return false;
  throw new ConflictException("Receipt differs from committed payment");
}

async function savePricedRequest(
  tx: Transaction,
  context: Context,
  run: Run,
  step: Step,
  receipt: VideoReceipt,
  previousCost: number | undefined,
  paid: RunPaidCalls,
): Promise<boolean> {
  const { workspaceId, channelId } = run;
  const claim = await readAdmission(tx, context, step);
  const cost = receipt.costMinor;
  const reservation = receiptReservation(run, step, claim);
  if (reservation.status === "COMMITTED") return verifyLegacyPayment(claim, reservation, receipt);
  const { request } = claim;
  await paid.usage.coverShotReceipt(tx, workspaceId, channelId, reservation, cost);
  const overage = cost > (step.costMinor ?? 0);
  const data = {
    status: "SUCCEEDED" as const,
    errorCode: overage ? BILLING_OVERAGE : null,
    actualCost: new Prisma.Decimal(cost).div(100),
    responseMetadata: { providerJobId: step.providerJobId!, dispatched: true, costKnown: true },
  };
  if (samePricedRequest(request, data.errorCode, cost)) return true;
  if (!request) {
    await tx.providerRequest.create({
      data: {
        workspaceId,
        channelId,
        correlationId: step.id,
        providerId: step.providerId!,
        capabilityId: receipt.modelId,
        createdAt: reservation.createdAt,
        currency: reservation.currency,
        estimatedCost: new Prisma.Decimal(
          (step.costMinor ?? reservation.amountMinor).toString(),
        ).div(100),
        ...data,
      },
    });
    return true;
  }
  const saved = await tx.providerRequest.updateMany({
    where: {
      id: request.id,
      workspaceId: run.workspaceId,
      ...(previousCost === undefined
        ? { errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN] } }
        : {
            status: "SUCCEEDED",
            errorCode: previousCost > (step.costMinor ?? 0) ? BILLING_OVERAGE : null,
            actualCost: new Prisma.Decimal(previousCost).div(100),
          }),
    },
    data,
  });
  if (saved.count !== 1) throw new ConflictException("Billing claim changed");
  return true;
}

/** Correct the original commitment in its accounting period without completing the clip again. */
async function correctSettledReceipt(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  merged: NonNullable<ReturnType<typeof mergeShotReceipt>>,
): Promise<ReceiptBudget | undefined> {
  const { previousCost: previous, cost } = merged;
  const claim = await readAdmission(tx, context, step);
  const reservation = receiptReservation(run, step, claim);
  const { request } = claim;
  const reserved = request?.estimatedCost?.mul(100).toNumber();
  const importedEstimate = importedShotEstimate(claim, previous);
  if (
    previous === undefined ||
    previous !== step.costMinor ||
    reservation.status !== "COMMITTED" ||
    !request ||
    (!importedEstimate && !matchesCommit(claim, BigInt(previous))) ||
    reserved === undefined ||
    !Number.isSafeInteger(reserved) ||
    reserved < 0
  )
    throw new ConflictException("Stored receipt differs from settled payment");
  const budget = readReceiptBudget(step.output);
  const admitted = budget?.admittedMinor ?? reserved;
  if (previous === cost && !importedEstimate) return budget;
  await paid.usage.coverShotReceipt(
    tx,
    run.workspaceId,
    run.channelId,
    reservation,
    cost,
    importedEstimate ? reservation.committedMinor! : BigInt(previous),
  );
  const updated = await tx.providerRequest.updateMany({
    where: {
      id: request.id,
      workspaceId: run.workspaceId,
      status: "SUCCEEDED",
      errorCode: null,
      actualCost: importedEstimate ? null : new Prisma.Decimal(previous).div(100),
    },
    data: { actualCost: new Prisma.Decimal(cost).div(100) },
  });
  if (updated.count !== 1) throw new ConflictException("Settled billing claim changed");
  const nextBuffer = budget ? Math.max(0, admitted - cost) : 0;
  await adjustEnvelope(db, run.id, {
    spentMinor: cost - previous,
    overageMinor: Math.max(0, cost - admitted) - Math.max(0, previous - admitted),
    reservedMinor: nextBuffer - (budget?.bufferMinor ?? 0),
  });
  return budget && { ...budget, bufferMinor: nextBuffer };
}

/** Keep the highest reported charge and the latest staged media for the accepted job. */
export async function captureShotReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  receipt: VideoReceipt,
): Promise<Step> {
  const result = await store.mutate(
    context,
    step.runId,
    "provider_receipt",
    async (db, run, tx) => {
      const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      requireReceiptAttempt(current, step);
      if (terminalBilledShot(current)) {
        return captureRefusedBill(db, tx, run, current, receipt);
      }
      const settled = current.state === "SUCCEEDED";
      const pending = pendingCorrection(current);
      const price = highestObservedReceipt(pending, receipt);
      const merged = mergeShotReceipt(current, price);
      if (!merged) return { value: current, payload: { replay: true } };
      const { priceChanged, previousCost, output, cost } = merged;
      const overage = cost > (current.costMinor ?? 0);
      let updatedOutput = output;
      if (settled) {
        const budget = await correctSettledReceipt(db, tx, paid, context, run, current, merged);
        if (budget) updatedOutput = withReceiptBudget(output, budget);
        await invalidateAssemblyManifests(db, run.id);
      } else if (
        priceChanged &&
        !(await savePricedRequest(tx, context, run, current, price, previousCost, paid))
      )
        return { value: current, payload: { replay: true } };
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: {
          output: updatedOutput,
          ...(pending && { error: Prisma.DbNull }),
          ...(settled ? { costMinor: cost } : overage && { error: { code: BILLING_OVERAGE } }),
        },
      });
      if (pending && run.pauseReason?.startsWith("RECONCILE_REQUIRED"))
        await clearResolvedSubmissionHold(db, tx, run, step.id);
      if (!settled && priceChanged && overage) await recordShotBillingHold(db, run, step.id);
      return {
        value: await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
        payload: settled ? correctionPayload(current, price) : { costMinor: cost, overage },
        stepId: step.id,
      };
    },
  );
  return result.value;
}

/** Settle the stored receipt under the same run lock used for price corrections. */
export async function reconcilePricedReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
): Promise<void> {
  await store.mutate(context, step.runId, "billing_reconciled", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (current.state === "SUCCEEDED") return { value: null, payload: { replay: true } };
    const claim = await readAdmission(tx, context, current);
    const cost = deliveredShot(current)?.receipt.costMinor;
    if (
      claim.evidence !== "billing-overage" ||
      !awaitingBilling(current) ||
      cost === undefined ||
      current.state !== "WAITING_EXTERNAL" ||
      !claim.request?.actualCost?.mul(100).equals(cost)
    )
      throw new ConflictException("Stored billing evidence changed");
    await settleReceipt(db, tx, paid, context, run, current, cost, current.output as Json);
    const reserved = current.costMinor ?? 0;
    return { value: null, payload: { costMinor: cost, reservedMinor: reserved }, stepId: step.id };
  });
}

async function settleReceipt(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  cost: number,
  output: Json,
): Promise<void> {
  const reserved = step.costMinor ?? 0;
  const budget = readReceiptBudget(step.output);
  const bufferMinor = budget ? Math.max(0, budget.admittedMinor - cost) : 0;
  await paid.commitJob(tx, context, step, cost);
  await adjustEnvelope(db, run.id, {
    reservedMinor: bufferMinor - reserved,
    spentMinor: cost,
    overageMinor: Math.max(0, cost - reserved),
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: {
      state: "SUCCEEDED",
      costMinor: cost,
      finishedAt: new Date(),
      output: budget ? withReceiptBudget(output, { ...budget, bufferMinor }) : output,
      error: Prisma.DbNull,
    },
  });
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  await failSettledGeneration(db, { ...run, pauseReason });
}

export async function recordShotArtifact(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  artifact: Artifact,
): Promise<{ value: number | null; event: import("../runs/runs.types.js").Event }> {
  return store.mutate(context, step.runId, "step_completed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (SETTLED_SHOTS.some((state) => state === current.state))
      return { value: null, payload: { replay: true } };
    const correction = pendingCorrection(current);
    if (correction) throw new ConflictException(correctionHold(step.id));
    if (
      current.state !== "WAITING_EXTERNAL" ||
      current.providerJobId !== step.providerJobId ||
      !current.providerJobId
    )
      throw new ConflictException("Provider job claim changed");
    const reserved = current.costMinor ?? 0;
    const pending = pendingShotMedia(current);
    if (awaitingBilling(current) && !pending) return { value: null, payload: { replay: true } };
    const receiptBudget = readReceiptBudget(current.output);
    const cost = pending?.receipt.costMinor ?? receiptBudget?.estimateMinor ?? reserved;
    const output = json({
      ...admissionFields(current),
      storageArtifacts: [artifact],
      ...(pending && {
        receipt: {
          ...pending.receipt,
          objectKey: artifact.objectKey,
          checksumSha256: artifact.checksumSha256,
          mimeType: "video/mp4",
        },
      }),
    });

    if (cost > reserved) {
      await db.videoRunStep.updateMany({ where: { id: step.id }, data: { output } });
      return {
        value: null,
        eventType: "reconcile_required",
        stepId: step.id,
        payload: { reason: billingHold(step.id), costMinor: cost },
      };
    }
    await settleReceipt(db, tx, paid, context, run, current, cost, output);
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    return {
      value: cost,
      stepId: step.id,
      payload: { costMinor: cost, warn: budget.spentMinor > pinnedBudget(run).targetMinor },
    };
  });
}
