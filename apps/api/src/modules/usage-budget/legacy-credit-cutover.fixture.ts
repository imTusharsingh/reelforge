import { randomUUID } from "node:crypto";
import type { Tenant } from "../runs/runs.fixture.js";

export async function historicalCredit(
  t: Tenant,
  target: { textAttemptId: string; dispatchKey: string } | { providerRequestId: string },
): Promise<string> {
  const { workspaceId, channelId } = t.run;
  const base = {
    workspaceId,
    channelId,
    actorUserId: t.context.userId,
    correlationId: randomUUID(),
    reason: "matched refund",
  };
  const row = await t.db.usageAdjustment.create({
    data: { ...base, kind: "CREDIT", currency: "USD", amountMinor: 3n },
  });
  await t.db.usageAuditRecord.create({
    data: {
      workspaceId,
      actorUserId: base.actorUserId,
      correlationId: base.correlationId,
      reason: base.reason,
      action: "CREDIT",
      adjustmentId: row.id,
      after: {
        adjustment: {
          id: row.id,
          channelId,
          operationKey: `refund:${row.id}`,
          amountMinor: 3,
          currency: "USD",
          ...target,
        },
      },
    },
  });
  return row.id;
}
