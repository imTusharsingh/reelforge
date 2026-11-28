import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { lockBooks } from "./text-admission-lock.js";
import { legacyObject } from "./legacy-text-import-fields.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import type { Context, Run, Step, Transaction } from "../runs/runs.types.js";
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
    historical &&
    reservation?.status === "COMMITTED" &&
    (await isMainRoutedEstimate(tx, row, reservation));
  const pricing = oldEstimate ? { ...row, actualCost: null } : row;
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
  if (reservation?.status === "RESERVED")
    throw new ConflictException("Media reservation is still open");
  if (reservation?.status === "COMMITTED") {
    if (
      !["IMAGE_MEDIA", "VIDEO_MEDIA", "TTS", "MUSIC"].includes(reservation.category) ||
      reservation.currency !== cost.currency ||
      reservation.channelId !== channelId ||
      reservation.committedMinor === null ||
      (!finalBill && reservation.committedMinor < amountMinor)
    )
      throw new ConflictException("Credit exceeds the remaining committed media charge");
    const reduction = finalBill ? reservation.committedMinor - cost.amountMinor : amountMinor;
    if (reduction !== 0n) await reduceCoveredCharge(tx, row.correlationId, reservation, reduction);
  }
  if (oldEstimate)
    await tx.providerRequest.update({ where: { id: row.id }, data: { actualCost: null } });
  return cost.currency;
}

async function isMainRoutedEstimate(
  tx: Transaction,
  row: { id: string; correlationId: string; status: string; errorCode: string | null },
  reservation: { id: string; amountMinor: bigint; idempotencyKey: string; category: string },
): Promise<boolean> {
  if (
    row.status !== "SUCCEEDED" ||
    row.errorCode !== null ||
    reservation.category !== "VIDEO_MEDIA" ||
    reservation.idempotencyKey !== `m08:${row.correlationId}`
  )
    return false;
  const request = await tx.providerRequest.findUniqueOrThrow({ where: { id: row.id } });
  const metadata = legacyObject(request.responseMetadata);
  return (
    request.actualCost !== null &&
    request.estimatedCost !== null &&
    request.actualCost.equals(request.estimatedCost) &&
    legacyObject(request.usage).seconds === null &&
    metadata.reservationId === reservation.id &&
    metadata.estimateMinor === Number(reservation.amountMinor) &&
    typeof metadata.providerJobId === "string"
  );
}

// A verified bill supersedes an estimate and its linked refund; it does not deliver the refused clip.
export async function settleRefusedShotBill(
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
): Promise<void> {
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
}
