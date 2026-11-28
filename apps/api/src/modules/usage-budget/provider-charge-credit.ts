import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Context, Transaction } from "../runs/runs.types.js";
import { auditCredit, type BudgetAccess, type CreditResult } from "./charge-credit-audit.js";
import { categorize, classifyCost, readLedgerRows } from "./usage-budget.ledger.js";
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
  const locked = await budgets.lock(charge.channelId);
  await tx.$queryRaw`SELECT id FROM provider_requests WHERE workspace_id = ${workspaceId}::uuid AND id = ${providerRequestId}::uuid FOR UPDATE`;
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
  const currency = await remainingMediaCharge(
    tx,
    { workspaceId, providerRequestId, now },
    charge.channelId,
    amountMinor,
  );
  const before = await budgets.statuses(locked);
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

async function remainingMediaCharge(
  tx: Transaction,
  filter: { workspaceId: string; providerRequestId: string; now: Date },
  channelId: string | null,
  amountMinor: bigint,
): Promise<string> {
  const [row] = await readLedgerRows(tx, filter);
  const cost = row && classifyCost(row);
  if (
    !row ||
    row.channelId !== channelId ||
    !["IMAGE_MEDIA", "VIDEO_MEDIA", "TTS", "MUSIC"].includes(categorize(row)) ||
    cost?.kind !== "FAILED_ESTIMATED" ||
    !cost.currency ||
    cost.amountMinor === null ||
    amountMinor > cost.amountMinor
  )
    throw new ConflictException("Credit requires a remaining failed-at-estimate media charge");
  return cost.currency;
}
