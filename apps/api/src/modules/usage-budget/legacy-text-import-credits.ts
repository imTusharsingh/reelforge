import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import type { Step, Transaction } from "../runs/runs.types.js";

type Credit = Prisma.UsageAdjustmentGetPayload<object>;
type Proof = { adjustmentId: string; operationKey: string };
export type LegacyCredits = { rows: Credit[]; links: Proof[] };
const mediaAudit = z.object({ adjustment: z.object({ providerRequestId: z.uuid() }) });
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
  const linkedIds = new Set(rows.map(({ id }) => id));
  const links: Proof[] = [];
  for (const audit of audits) {
    if (audit.adjustmentId && linkedIds.has(audit.adjustmentId)) continue;
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
      credit.providerRequestId !== null ||
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

// Old adjustment rows used the same DB kind for every credit. Only an explicit
// independent budget adjustment or an exact charge audit can classify one.
export async function unresolvedLegacyCredits(
  tx: Transaction,
  workspaceId: string,
  allowPendingLinks: boolean,
): Promise<string[]> {
  const candidates = await tx.$queryRaw<{ id: string; channelId: string | null }[]>`
    SELECT c.id, c.channel_id AS "channelId" FROM usage_adjustments c
    WHERE c.workspace_id = ${workspaceId}::uuid AND c.kind = 'CREDIT' AND c.text_attempt_id IS NULL AND c.provider_request_id IS NULL
      AND NOT EXISTS (
        SELECT FROM usage_audit_records a
        WHERE a.workspace_id = c.workspace_id AND a.adjustment_id = c.id AND a.action = 'CREDIT'
          AND a.actor_user_id = c.actor_user_id AND a.correlation_id = c.correlation_id
          AND a.after->'adjustment' @> jsonb_build_object('id', c.id, 'kind', 'BUDGET_CREDIT',
              'channelId', c.channel_id, 'currency', c.currency, 'amountMinor', c.amount_minor)
      )
    ORDER BY c.id`;
  if (!allowPendingLinks) return candidates.map((row) => row.id);
  const unresolved: string[] = [];
  for (const row of candidates) {
    const audits = await tx.usageAuditRecord.findMany({
      where: { workspaceId, action: "CREDIT", adjustmentId: row.id },
      select: { after: true },
    });
    if (audits.some((a) => mediaAudit.safeParse(a.after).success)) {
      unresolved.push(row.id);
      continue;
    }
    const proofs = audits.flatMap((audit) => {
      const parsed = proof.safeParse(audit.after);
      return parsed.success ? [parsed.data.adjustment] : [];
    });
    const [charge] = proofs;
    if (proofs.length === 1 && charge && row.channelId) {
      const step = await tx.videoRunStep.findFirst({
        where: {
          workspaceId,
          id: charge.textAttemptId,
          key: { startsWith: "media:text:" },
          run: { channelId: row.channelId },
        },
      });
      const matched = step && (await auditedLegacyCredits(tx, step, row.channelId));
      if (matched?.links.some((link) => link.adjustmentId === row.id)) continue;
    }
    unresolved.push(row.id);
  }
  return unresolved;
}
