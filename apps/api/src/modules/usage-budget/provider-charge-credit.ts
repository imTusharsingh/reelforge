import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Context, Transaction } from "../runs/runs.types.js";
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
  const cost = classifyCost(row);
  const finalBill = historical && cost?.kind === "ACTUAL";
  if (
    (!(
      reservation?.idempotencyKey === `m08:${row.correlationId}` &&
      reservation.category === "VIDEO_MEDIA"
    ) &&
      !["IMAGE_MEDIA", "VIDEO_MEDIA", "TTS", "MUSIC"].includes(categorize(row))) ||
    (!finalBill && (!terminalMediaFailure(row.errorCode) || cost?.kind !== "FAILED_ESTIMATED")) ||
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
  return cost.currency;
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
