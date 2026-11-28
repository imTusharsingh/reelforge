import { scopedTransaction } from "../runs/runs.transaction.js";
import { RECOVERY_PRINCIPAL } from "../runs/runs.types.js";
import { Prisma } from "@reelforge/database";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { lockBooks } from "./text-admission-lock.js";
import { z } from "zod";
import { clearResolvedSubmissionHold } from "../runs/run-outcomes.js";
import { writeRefusalCreditEvent } from "../composition/assembly-refusal-cost.js";
import { invalidateAssemblyManifests } from "../composition/assembly-receipts.js";
import {
  correctionHold,
  highestObservedReceipt,
  pendingCorrection,
} from "./run-pending-receipt.js";
import { correctionPayload, pricedOutput, terminalBilledShot } from "./run-shot-receipt.js";
import { legacyObject } from "./legacy-text-import-fields.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import type { Context, Json, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import { auditCredit, type BudgetAccess, type CreditResult } from "./charge-credit-audit.js";
import {
  categorize,
  classifyCost,
  readLedgerRows,
  terminalMediaFailure,
} from "./usage-budget.ledger.js";
import type { ProviderCreditRequest } from "./usage-budget.validation.js";

export async function createProviderCredit(
  tx: Transaction,
  context: Context,
  input: ProviderCreditRequest,
  now: Date,
  budgets: BudgetAccess,
): Promise<CreditResult> {
  const { workspaceId, userId } = context;
  const { providerRequestId, operationKey, reason } = input;
  const charge = await tx.providerRequest.findFirst({
    where: { id: providerRequestId, workspaceId },
  });
  if (!charge) throw new NotFoundException("Provider charge not found");
  // Match the settlement writer's run -> workspace -> provider lock order.
  await tx.$queryRaw`SELECT r.id FROM video_runs r JOIN video_run_steps s ON s.run_id = r.id
    WHERE r.workspace_id = ${workspaceId}::uuid AND s.workspace_id = r.workspace_id
      AND s.id = ${charge.correlationId}::uuid FOR UPDATE OF r`;
  const locked = await budgets.lock(charge.channelId);

  const existing = await tx.usageAdjustment.findUnique({
    where: { workspaceId_operationKey: { workspaceId, operationKey } },
  });
  const amountMinor = BigInt(input.amountMinor);
  if (existing) {
    if (
      existing.providerRequestId !== providerRequestId ||
      existing.amountMinor !== amountMinor ||
      existing.reason !== reason
    )
      throw new ConflictException("Credit operation key already identifies a different adjustment");
    return {
      adjustmentId: existing.id,
      correlationId: existing.correlationId,
      budgets: await budgets.statuses(locked),
    };
  }
  const before = await budgets.statuses(locked);
  const currency = await postMediaCredit(
    tx,
    { workspaceId, providerRequestId, now },
    charge.channelId,
    amountMinor,
  );
  const adjustment = await tx.usageAdjustment.create({
    data: {
      workspaceId,
      channelId: charge.channelId,
      providerRequestId,
      operationKey,
      kind: "CREDIT",
      currency,
      amountMinor,
      reason,
      actorUserId: userId,
      correlationId: randomUUID(),
      createdAt: now,
    },
  });
  const after = await budgets.statuses(locked);
  await auditCredit(tx, context, input, adjustment, { now, before, after });
  return { adjustmentId: adjustment.id, correlationId: adjustment.correlationId, budgets: after };
}

export async function postMediaCredit(
  tx: Transaction,
  filter: { workspaceId: string; providerRequestId: string; now: Date },
  channelId: string | null,
  amountMinor: bigint,
  historical = false,
): Promise<string> {
  await tx.$queryRaw`SELECT id FROM provider_requests WHERE workspace_id = ${filter.workspaceId}::uuid AND id = ${filter.providerRequestId}::uuid FOR UPDATE`;
  const [row] = await readLedgerRows(tx, filter);
  if (!row || row.channelId !== channelId)
    throw new ConflictException("Media charge scope changed");
  const [reservation, other] = await tx.usageReservation.findMany({
    where: {
      workspaceId: filter.workspaceId,
      correlationId: row.correlationId,
      OR: [{ status: "COMMITTED" }, { status: "RESERVED", expiresAt: { gt: filter.now } }],
    },
    take: 2,
  });
  if (other) throw new ConflictException("Ambiguous media reservation");
  const oldEstimate =
    historical && reservation?.status === "COMMITTED"
      ? await mainVideoEstimate(tx, row, reservation)
      : null;
  const pricing = oldEstimate
    ? { ...row, actualCost: null, estimatedCost: oldEstimate.gross }
    : row;
  const cost = classifyCost(pricing);
  const finalBill = historical && cost?.kind === "ACTUAL";
  if (
    (!(
      reservation?.idempotencyKey === `m08:${row.correlationId}` &&
      reservation.category === "VIDEO_MEDIA"
    ) &&
      !["IMAGE_MEDIA", "VIDEO_MEDIA", "TTS", "MUSIC"].includes(categorize(row))) ||
    (!finalBill &&
      !oldEstimate &&
      (!terminalMediaFailure(row.errorCode) || cost?.kind !== "FAILED_ESTIMATED")) ||
    !cost?.currency ||
    cost.amountMinor === null ||
    (!finalBill && amountMinor > cost.amountMinor)
  )
    throw new ConflictException("Credit requires a remaining failed-at-estimate media charge");
  if (reservation)
    await applyCreditPosting(tx, reservation, row.correlationId, channelId, {
      amountMinor,
      cost: { amountMinor: cost.amountMinor, currency: cost.currency },
      finalBill,
      keepGrossShot: oldEstimate?.shot === true,
    });
  if (oldEstimate)
    await tx.providerRequest.update({
      where: { id: row.id },
      data: {
        actualCost: null,
        responseMetadata: { ...oldEstimate.metadata, legacyEstimateMinor: oldEstimate.minor },
      },
    });
  return cost.currency;
}

async function applyCreditPosting(
  tx: Transaction,
  reservation: Prisma.UsageReservationGetPayload<object>,
  correlationId: string,
  channelId: string | null,
  {
    amountMinor,
    cost,
    finalBill,
    keepGrossShot,
  }: {
    amountMinor: bigint;
    cost: { amountMinor: bigint; currency: string };
    finalBill: boolean;
    keepGrossShot: boolean;
  },
): Promise<void> {
  if (reservation.status === "RESERVED")
    throw new ConflictException("Media reservation is still open");
  if (reservation.status === "COMMITTED") {
    if (
      !["IMAGE_MEDIA", "VIDEO_MEDIA", "TTS", "MUSIC"].includes(reservation.category) ||
      reservation.currency !== cost.currency ||
      reservation.channelId !== channelId ||
      reservation.committedMinor === null ||
      (!finalBill && reservation.committedMinor < amountMinor)
    )
      throw new ConflictException("Credit exceeds the remaining committed media charge");
    const reduction = finalBill ? reservation.committedMinor - cost.amountMinor : amountMinor;
    if (keepGrossShot) {
      // Keep the archived gross receipt and envelope intact; the commitment carries the refund.
      await tx.usageReservation.update({
        where: { id: reservation.id },
        data: { committedMinor: { decrement: reduction } },
      });
    } else if (reduction !== 0n) {
      const step = await reduceCoveredCharge(tx, correlationId, reservation, reduction);
      if (step && terminalBilledShot(step)) {
        await writeRefusalCreditEvent(tx, step, -Number(reduction));
        const db = scopedTransaction(tx, {
          workspaceId: step.workspaceId,
          userId: RECOVERY_PRINCIPAL,
          role: "OWNER",
        });
        await invalidateAssemblyManifests(db, step.runId);
      }
    }
  }
}

async function mainVideoEstimate(
  tx: Transaction,
  row: { id: string; correlationId: string; status: string; errorCode: string | null },
  reservation: Prisma.UsageReservationGetPayload<object>,
): Promise<{
  gross: string;
  minor: number;
  metadata: ReturnType<typeof legacyObject>;
  shot: boolean;
} | null> {
  if (
    row.status !== "SUCCEEDED" ||
    row.errorCode !== null ||
    reservation.category !== "VIDEO_MEDIA" ||
    reservation.currency !== "USD"
  )
    return null;
  const request = await tx.providerRequest.findUniqueOrThrow({ where: { id: row.id } });
  if (request.channelId !== reservation.channelId || request.currency !== reservation.currency)
    return null;
  const metadata = legacyObject(request.responseMetadata);
  const step = await tx.videoRunStep.findFirst({
    where: { workspaceId: reservation.workspaceId, id: row.correlationId },
  });
  const shot = !!step && mainShotEstimate(step, reservation.idempotencyKey, request.providerId);
  const routed =
    !step &&
    reservation.idempotencyKey === `m08:${row.correlationId}` &&
    legacyObject(request.usage).seconds === null &&
    metadata.reservationId === reservation.id &&
    metadata.estimateMinor === Number(reservation.amountMinor) &&
    typeof metadata.providerJobId === "string";
  if (!shot && !routed) return null;
  const booked =
    request.actualCost ??
    (typeof metadata.legacyEstimateMinor === "number"
      ? routed
        ? request.estimatedCost
        : new Prisma.Decimal(metadata.legacyEstimateMinor).div(100)
      : null);
  if (
    !booked ||
    (shot && !booked.mul(100).equals(step.costMinor!)) ||
    (routed && !request.estimatedCost?.equals(booked))
  )
    return null;
  const minor = Math.round(booked.mul(100).toNumber());
  if (
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    (request.actualCost === null && metadata.legacyEstimateMinor !== minor)
  )
    return null;
  return { gross: booked.toString(), minor, metadata, shot };
}

function mainShotEstimate(step: Step, key: string, providerId: string): boolean {
  const saved = pricedOutput.safeParse(step.output).data?.receipt;
  return (
    step.key.startsWith("shot-") &&
    step.state === "SUCCEEDED" &&
    step.providerId === providerId &&
    !!step.providerJobId &&
    saved?.providerJobId === step.providerJobId &&
    saved.costBasis === "RESERVATION" &&
    saved.costMinor === step.costMinor &&
    key === `m08:${step.idempotencyKey}`
  );
}

export async function captureRefusedBill(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  receipt: VideoReceipt,
): Promise<{ value: Step; stepId: string; payload: Json }> {
  const pending = pendingCorrection(step);
  const price = highestObservedReceipt(pending, receipt);
  const changed = await settleRefusedShotBill(tx, run, step, price);
  if (pending) {
    const { pendingRefusalBill: _, ...output } = z.record(z.string(), z.json()).parse(step.output);
    await db.videoRunStep.updateMany({ where: { id: step.id }, data: { output } });
    if (run.pauseReason === correctionHold(step.id))
      await clearResolvedSubmissionHold(db, tx, run, step.id);
  }
  if (changed) await invalidateAssemblyManifests(db, run.id);
  return {
    value: changed ? { ...step, costMinor: price.costMinor } : step,
    stepId: step.id,
    payload: changed ? correctionPayload(step, price, true) : { replay: true },
  };
}

// A verified bill supersedes an estimate and its linked refund; it does not deliver the refused clip.
async function settleRefusedShotBill(
  tx: Transaction,
  run: Run,
  step: Step,
  receipt: VideoReceipt,
): Promise<boolean> {
  if (receipt.costBasis !== "BILLED") return false;
  const { workspaceId, channelId } = run;
  await lockBooks(tx, run);
  const request = await tx.providerRequest.findUnique({
    where: { workspaceId_correlationId: { workspaceId, correlationId: step.id } },
  });
  const reservation = await tx.usageReservation.findUnique({
    where: {
      workspaceId_idempotencyKey: { workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
    },
  });
  const metadata = legacyObject(request?.responseMetadata);
  if (
    !request ||
    request.status !== "FAILED" ||
    request.errorCode !== "PROVIDER_JOB_FAILED" ||
    request.providerId !== step.providerId ||
    request.channelId !== channelId ||
    request.currency !== "USD" ||
    !step.providerJobId ||
    metadata.providerJobId !== step.providerJobId ||
    metadata.dispatched !== true ||
    reservation?.status !== "COMMITTED" ||
    reservation.committedMinor === null ||
    reservation.category !== "VIDEO_MEDIA" ||
    reservation.currency !== request.currency ||
    reservation.channelId !== channelId ||
    reservation.correlationId !== step.id
  ) {
    throw new ConflictException("Refused shot billing does not match the original charge");
  }
  const cents = BigInt(receipt.costMinor);
  if (request.actualCost !== null && request.actualCost.mul(100).gte(cents.toString()))
    return false;
  await reduceCoveredCharge(tx, step.id, reservation, reservation.committedMinor - cents);
  await tx.providerRequest.update({
    where: { id: request.id },
    data: {
      actualCost: (receipt.costMinor / 100).toFixed(2),
      responseMetadata: { ...metadata, costKnown: true },
    },
  });
  return true;
}

async function reduceCoveredCharge(
  tx: Transaction,
  correlationId: string,
  reservation: {
    workspaceId: string;
    id: string;
    idempotencyKey: string;
    committedMinor: bigint | null;
  },
  amount: bigint,
): Promise<Step | null> {
  const { workspaceId } = reservation;
  const step = await tx.videoRunStep.findFirst({ where: { workspaceId, id: correlationId } });
  if (step) {
    if (
      reservation.idempotencyKey !== `m08:${step.idempotencyKey}` ||
      !["SKIPPED", "FAILED"].includes(step.state) ||
      step.costMinor === null ||
      BigInt(step.costMinor) !== reservation.committedMinor
    )
      throw new ConflictException("Terminal media step and original booking do not match");
    const delta = Number(amount);
    await tx.videoRunStep.update({
      where: { id: step.id },
      data: { costMinor: { decrement: delta } },
    });
    const envelope = await tx.budgetEnvelope.findFirst({
      where: { workspaceId, runId: step.runId },
    });
    if (envelope) {
      const spentMinor = envelope.spentMinor - delta;
      if (spentMinor < 0) throw new ConflictException("Media credit would underflow the envelope");
      await tx.budgetEnvelope.update({
        where: { id: envelope.id },
        data: {
          spentMinor,
          overageMinor: Math.max(
            Math.min(spentMinor, envelope.overageMinor),
            spentMinor + envelope.reservedMinor - envelope.hardCapMinor,
          ),
          revision: { increment: 1 },
        },
      });
    }
  }
  await tx.usageReservation.update({
    where: { id: reservation.id },
    data: { committedMinor: { decrement: amount } },
  });
  return step;
}
