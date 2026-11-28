import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@reelforge/database";
import type { Context, Step, Transaction } from "../runs/runs.types.js";
import type { BudgetRecord } from "./effective-budgets.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import {
  appendTextEvidence,
  lockTextAttempt,
  readTextAttempt,
  type TextAttemptState,
} from "./text-attempt-store.js";
import type { BudgetStatusView } from "./usage-budget.types.js";
import type { LinkedTextCreditRequest } from "./usage-budget.validation.js";

type BudgetAccess = {
  lock: (channelId: string) => Promise<BudgetRecord[]>;
  statuses: (budgets: BudgetRecord[]) => Promise<BudgetStatusView[]>;
};
type CreditResult = { adjustmentId: string; correlationId: string; budgets: BudgetStatusView[] };

/** Append a credit under the original run lock, then derive its net spend before commit. */
export async function createLinkedTextCredit(
  tx: Transaction,
  context: Context,
  input: LinkedTextCreditRequest,
  now: Date,
  budgets: BudgetAccess,
): Promise<CreditResult> {
  const { workspaceId, userId } = context;
  const step = await lockTextAttempt(tx, workspaceId, input.textAttemptId);
  const { channelId } = await tx.videoRun.findUniqueOrThrow({
    where: { workspaceId_id: { workspaceId, id: step.runId } },
    select: { channelId: true },
  });
  const locked = await budgets.lock(channelId);
  const existing = await tx.usageAdjustment.findUnique({
    where: { workspaceId_operationKey: { workspaceId, operationKey: input.operationKey } },
  });
  const amount = BigInt(input.amountMinor);
  if (existing) {
    if (
      existing.textAttemptId !== step.id ||
      existing.amountMinor !== amount ||
      existing.reason !== input.reason
    )
      throw new ConflictException("Credit operation key already identifies a different adjustment");
    return {
      adjustmentId: existing.id,
      correlationId: existing.correlationId,
      budgets: await budgets.statuses(locked),
    };
  }
  const currency = await requireCreditableCharge(tx, workspaceId, channelId, step, amount);
  const before = await budgets.statuses(locked);
  const adjustment = await tx.usageAdjustment.create({
    data: {
      workspaceId,
      channelId,
      kind: "CREDIT",
      currency,
      amountMinor: amount,
      reason: input.reason,
      actorUserId: userId,
      correlationId: randomUUID(),
      createdAt: now,
      textAttemptId: step.id,
      operationKey: input.operationKey,
    },
  });
  await appendTextEvidence(tx, step, {
    kind: "CREDIT",
    eventKey: `credit:${adjustment.id}`,
    data: { adjustmentId: adjustment.id, amountMinor: input.amountMinor },
  });
  await foldTextAttempt(tx, context, step.id);
  const after = await budgets.statuses(locked);
  await auditCredit(tx, context, input, adjustment, { now, before, after });
  return { adjustmentId: adjustment.id, correlationId: adjustment.correlationId, budgets: after };
}

async function auditCredit(
  tx: Transaction,
  context: Context,
  input: LinkedTextCreditRequest,
  adjustment: { id: string; channelId: string | null; currency: string; correlationId: string },
  { now, before, after }: { now: Date; before: BudgetStatusView[]; after: BudgetStatusView[] },
): Promise<void> {
  await tx.usageAuditRecord.create({
    data: {
      workspaceId: context.workspaceId,
      action: "CREDIT",
      actorUserId: context.userId,
      reason: input.reason,
      before: { budgets: before } as unknown as Prisma.InputJsonValue,
      after: {
        adjustment: {
          id: adjustment.id,
          channelId: adjustment.channelId,
          kind: "CREDIT",
          currency: adjustment.currency,
          amountMinor: input.amountMinor,
          textAttemptId: input.textAttemptId,
          operationKey: input.operationKey,
        },
        budgets: after,
      } as unknown as Prisma.InputJsonValue,
      correlationId: adjustment.correlationId,
      adjustmentId: adjustment.id,
      createdAt: now,
    },
  });
}

async function requireCreditableCharge(
  tx: Transaction,
  workspaceId: string,
  channelId: string,
  step: Step,
  amount: bigint,
): Promise<string> {
  const attempt = await readTextAttempt(tx, step);
  const reservation = await tx.usageReservation.findUnique({
    where: {
      workspaceId_idempotencyKey: { workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
    },
  });
  const request = await tx.providerRequest.findUnique({
    where: { workspaceId_correlationId: { workspaceId, correlationId: step.id } },
  });
  if (
    !attempt ||
    !reservation ||
    attempt.reservationId !== reservation.id ||
    attempt.currency !== reservation.currency ||
    reservation.category !== "LLM" ||
    reservation.status !== "COMMITTED" ||
    reservation.correlationId !== step.id ||
    reservation.channelId !== channelId ||
    !request ||
    request.channelId !== channelId ||
    request.currency !== reservation.currency ||
    reservation.committedMinor !== BigInt(attempt.netMinor)
  )
    throw new ConflictException("The original text attempt has no settled charge to credit");
  if (amount > remainingCredit(attempt))
    throw new ConflictException("Text credit would exceed the remaining charge");
  return reservation.currency;
}

function remainingCredit(attempt: TextAttemptState): bigint {
  if (
    attempt.phase === "OWNER_CONFIRMED" ||
    attempt.phase === "SUCCEEDED" ||
    (attempt.phase === "SENT" && attempt.actualMinor !== null)
  )
    return BigInt(attempt.netMinor);
  if (attempt.phase !== "REJECTED" || !attempt.ownerConfirmed)
    throw new ConflictException("The original text attempt has no settled charge to credit");
  // The settled estimate was already reversed. Keep later credits as audit evidence
  // only, bounded by the originally booked estimate rather than the zero net.
  const credited = Object.values(attempt.credits).reduce((sum, value) => sum + BigInt(value), 0n);
  return BigInt(attempt.estimateMinor) - credited;
}
