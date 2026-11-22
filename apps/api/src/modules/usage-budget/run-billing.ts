import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { pinnedBudget } from "./run-envelope.js";
import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import {
  billingHold,
  SETTLED_SHOTS,
  clearResolvedSubmissionHold,
  failSettledGeneration,
} from "../runs/run-outcomes.js";
import {
  ArtifactSchema,
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
  awaitingBilling,
  mergeShotReceipt,
  pendingShotMedia,
  pricedOutput,
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

/** The caller holds the run lock for the ledger, step and envelope writes. */
async function adjustEnvelope(
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

/** Correct the original commitment in its accounting period without completing the clip again. */
async function correctSettledReceipt(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  previous: number | undefined,
  cost: number,
): Promise<ReceiptBudget> {
  const claim = await readAdmission(tx, context, step);
  const reservation = receiptReservation(run, step, claim);
  const { request } = claim;
  const reserved = request?.estimatedCost?.mul(100).toNumber();
  if (
    previous === undefined ||
    previous !== step.costMinor ||
    reservation.status !== "COMMITTED" ||
    !request ||
    !matchesCommit(claim, BigInt(previous)) ||
    reserved === undefined ||
    !Number.isSafeInteger(reserved) ||
    reserved < 0
  )
    throw new ConflictException("Stored receipt differs from settled payment");
  const budget = readReceiptBudget(step.output, reserved, previous);
  const previousBuffer = budget.bufferMinor;
  if (previous === cost) return { ...budget, bufferMinor: previousBuffer };
  await paid.usage.coverShotReceipt(
    tx,
    run.workspaceId,
    run.channelId,
    reservation,
    cost,
    BigInt(previous),
  );
  const updated = await tx.providerRequest.updateMany({
    where: {
      id: request.id,
      workspaceId: run.workspaceId,
      status: "SUCCEEDED",
      errorCode: null,
      actualCost: new Prisma.Decimal(previous).div(100),
    },
    data: { actualCost: new Prisma.Decimal(cost).div(100) },
  });
  if (updated.count !== 1) throw new ConflictException("Settled billing claim changed");
  const nextBuffer = Math.max(0, budget.admittedMinor - cost);
  await adjustEnvelope(db, run.id, {
    spentMinor: cost - previous,
    overageMinor:
      Math.max(0, cost - budget.admittedMinor) - Math.max(0, previous - budget.admittedMinor),
    reservedMinor: nextBuffer - previousBuffer,
  });
  return { ...budget, bufferMinor: nextBuffer };
}

/** Identify the immutable manifest receipt. Its final price is the latest absolute cost for this job. */
function correctionPayload(step: Step, receipt: VideoReceipt): Json {
  return {
    key: step.key,
    providerId: step.providerId,
    providerJobId: step.providerJobId,
    costBasis: receipt.costBasis,
    seconds: receipt.seconds,
    previousCostMinor: step.costMinor,
    costMinor: receipt.costMinor,
    adjustmentMinor: receipt.costMinor - step.costMinor!,
  };
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
      if (
        current.providerJobId !== step.providerJobId ||
        current.providerId !== step.providerId ||
        !step.providerJobId
      )
        throw new ConflictException("Provider job claim changed");
      const settled = current.state === "SUCCEEDED";
      if (!settled && current.state !== "WAITING_EXTERNAL")
        throw new ConflictException("Provider job claim changed");
      const merged = mergeShotReceipt(current, receipt);
      if (!merged) return { value: current, payload: { replay: true } };
      const { priceChanged, previousCost, output, cost } = merged;
      const overage = cost > (current.costMinor ?? 0);
      let updatedOutput = output;
      if (settled)
        updatedOutput = withReceiptBudget(
          output,
          await correctSettledReceipt(db, tx, paid, context, run, current, previousCost, cost),
        );
      else if (
        priceChanged &&
        !(await savePricedRequest(tx, context, run, current, receipt, previousCost, paid))
      )
        return { value: current, payload: { replay: true } };
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: {
          output: updatedOutput,
          ...(settled ? { costMinor: cost } : overage && { error: { code: BILLING_OVERAGE } }),
        },
      });
      if (!settled && priceChanged && overage && run.pauseReason !== "EMERGENCY_STOP")
        await db.videoRun.updateMany({
          where: { id: run.id },
          data: { pauseReason: billingHold(step.id) },
        });
      return {
        value: await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
        payload: settled ? correctionPayload(current, receipt) : { costMinor: cost, overage },
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
    const { receipt } = pricedOutput.parse(current.output);
    const cost = receipt.costMinor;
    if (
      claim.evidence !== "billing-overage" ||
      !awaitingBilling(current) ||
      !z.object({ storageArtifacts: z.array(ArtifactSchema).min(1) }).safeParse(current.output)
        .success ||
      current.state !== "WAITING_EXTERNAL" ||
      receipt.providerJobId !== current.providerJobId ||
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
  const budget = readReceiptBudget(step.output, reserved, cost);
  const bufferMinor = Math.max(0, budget.admittedMinor - cost);
  await paid.commitJob(tx, context, step, cost);
  await adjustEnvelope(db, run.id, {
    reservedMinor: -Math.min(reserved, cost),
    spentMinor: cost,
    overageMinor: Math.max(0, cost - reserved),
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: {
      state: "SUCCEEDED",
      costMinor: cost,
      finishedAt: new Date(),
      output: withReceiptBudget(output, { ...budget, bufferMinor }),
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
): Promise<{ value: boolean; event: import("../runs/runs.types.js").Event }> {
  return store.mutate(context, step.runId, "step_completed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (SETTLED_SHOTS.some((state) => state === current.state))
      return { value: false, payload: { replay: true } };
    if (
      current.state !== "WAITING_EXTERNAL" ||
      current.providerJobId !== step.providerJobId ||
      !current.providerJobId
    )
      throw new ConflictException("Provider job claim changed");
    const reserved = current.costMinor ?? 0;
    const pending = pendingShotMedia(current);
    if (awaitingBilling(current) && !pending) return { value: false, payload: { replay: true } };
    const cost =
      pending?.receipt.costMinor ??
      readReceiptBudget(current.output, reserved, 0).estimateMinor ??
      reserved;
    const output = json({
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
        value: false,
        eventType: "reconcile_required",
        stepId: step.id,
        payload: { reason: billingHold(step.id), costMinor: cost },
      };
    }
    await settleReceipt(db, tx, paid, context, run, current, cost, output);
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    return {
      value: true,
      stepId: step.id,
      payload: { costMinor: cost, warn: budget.spentMinor > pinnedBudget(run).targetMinor },
    };
  });
}
