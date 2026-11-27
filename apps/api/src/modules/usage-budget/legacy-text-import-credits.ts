import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import type { Step, Transaction } from "../runs/runs.types.js";

type Credit = Prisma.UsageAdjustmentGetPayload<object>;
type Proof = { adjustmentId: string; operationKey: string };
export type LegacyCredits = { rows: Credit[]; links: Proof[] };
const proof = z.object({
  adjustment: z.object({
    id: z.uuid(),
    textAttemptId: z.uuid(),
    dispatchKey: z.string(),
    operationKey: z.string().trim().min(1).max(200),
    amountMinor: z.int().positive(),
    currency: z.string(),
  }),
});

/** A correlation ID alone is not a credit link. Require the FK or an exact, scoped audit row. */
export async function auditedLegacyCredits(
  tx: Transaction,
  step: Step,
  channelId: string,
): Promise<LegacyCredits | null> {
  const { workspaceId, id: textAttemptId, idempotencyKey } = step;
  const rows = await tx.usageAdjustment.findMany({
    where: { workspaceId, textAttemptId },
    orderBy: { id: "asc" },
  });
  const audits = await tx.usageAuditRecord.findMany({
    where: {
      workspaceId,
      action: "CREDIT",
      adjustmentId: { not: null },
      after: { path: ["adjustment", "textAttemptId"], equals: textAttemptId },
    },
    orderBy: { id: "asc" },
  });
  const links: Proof[] = [];
  for (const audit of audits) {
    const detail = proof.safeParse(audit.after).data?.adjustment;
    if (
      !detail ||
      detail.id !== audit.adjustmentId ||
      detail.textAttemptId !== textAttemptId ||
      detail.dispatchKey !== idempotencyKey
    )
      return null;
    const credit =
      rows.find(({ id }) => id === detail.id) ??
      (await tx.usageAdjustment.findFirst({ where: { workspaceId, id: detail.id } }));
    if (
      !credit ||
      credit.correlationId !== audit.correlationId ||
      credit.actorUserId !== audit.actorUserId ||
      credit.channelId !== channelId ||
      credit.kind !== "CREDIT" ||
      credit.amountMinor !== BigInt(detail.amountMinor) ||
      credit.currency !== detail.currency ||
      (credit.textAttemptId !== null && credit.textAttemptId !== textAttemptId) ||
      (credit.operationKey !== null && credit.operationKey !== detail.operationKey)
    )
      return null;
    if (rows.some(({ id }) => id === credit.id)) continue;
    links.push({ adjustmentId: detail.id, operationKey: detail.operationKey });
    rows.push({ ...credit, textAttemptId, operationKey: detail.operationKey });
  }
  if (new Set(rows.map((row) => row.operationKey)).size !== rows.length) return null;
  return { rows, links };
}
