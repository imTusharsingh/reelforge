import type { Prisma } from "@reelforge/database";
import type { BudgetRecord } from "./effective-budgets.js";
import type { BudgetStatusView } from "./usage-budget.types.js";
import type { Context, Transaction } from "../runs/runs.types.js";
import type { LinkedTextCreditRequest, ProviderCreditRequest } from "./usage-budget.validation.js";

export type BudgetAccess = {
  lock: (channelId: string | null) => Promise<BudgetRecord[]>;
  statuses: (budgets: BudgetRecord[]) => Promise<BudgetStatusView[]>;
};
export type CreditResult = {
  adjustmentId: string;
  correlationId: string;
  budgets: BudgetStatusView[];
};

export async function auditCredit(
  tx: Transaction,
  context: Context,
  input: LinkedTextCreditRequest | ProviderCreditRequest,
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
          ...("textAttemptId" in input
            ? { textAttemptId: input.textAttemptId }
            : { providerRequestId: input.providerRequestId }),
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
