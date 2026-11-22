import { Prisma } from "@reelforge/database";
import {
  classifyCost,
  confirmedNonDispatch,
  type LedgerReader,
  type LedgerRow,
} from "./usage-budget.ledger.js";
import type { PeriodBounds } from "./usage-budget.time.js";

type Price = Pick<LedgerRow, "currency" | "actualCost" | "estimatedCost" | "errorCode" | "status">;

// Historical settlements released their entire reservation. Only an explicitly retained
// buffer on the same paid attempt can contribute to current admission exposure.
const coveredMinor = Prisma.sql`CASE
  WHEN ur.status <> 'COMMITTED' THEN ur.amount_minor
  WHEN s.state = 'SUCCEEDED' THEN ur.committed_minor + COALESCE((s.output->'receiptBudget'->>'bufferMinor')::bigint, 0)
  WHEN s.state = 'WAITING_EXTERNAL' AND s.output ? 'receiptBudget' THEN GREATEST(ur.amount_minor, ur.committed_minor)
  ELSE ur.committed_minor END`;

/** Coverage, uncovered requests and adjustments must see the same MVCC snapshot. */
export async function budgetExposure(
  db: LedgerReader,
  budget: { workspaceId: string; channelId: string | null; currency: string },
  bounds: PeriodBounds,
  now: Date,
): Promise<{ consumed: bigint; unconverted: number }> {
  const channel = budget.channelId
    ? Prisma.sql`AND channel_id = ${budget.channelId}::uuid`
    : Prisma.empty;
  const period = Prisma.sql`workspace_id = ${budget.workspaceId}::uuid
    AND created_at >= ${bounds.start} AND created_at < ${bounds.end} ${channel}`;
  const rows = await db.$queryRaw<(Price & { minor: string | null; entries: bigint })[]>(Prisma.sql`
    WITH coverage AS (
      SELECT ur.correlation_id, ur.currency, ur.created_at, ur.channel_id, ${coveredMinor} AS minor
        FROM usage_reservations ur
        LEFT JOIN video_run_steps s ON s.workspace_id = ur.workspace_id AND s.id = ur.correlation_id
          AND ur.idempotency_key = 'm08:' || s.idempotency_key
       WHERE ur.workspace_id = ${budget.workspaceId}::uuid AND (
         ur.status = 'COMMITTED' OR (ur.status = 'RESERVED' AND ur.expires_at > ${now})
         OR (ur.status IN ('RESERVED', 'EXPIRED') AND s.state IN ('RUNNING','WAITING_EXTERNAL')
             AND ((s.state = 'WAITING_EXTERNAL' AND s.output ? 'receiptBudget') OR NOT EXISTS (
               SELECT FROM provider_requests pr WHERE pr.workspace_id = ur.workspace_id
                 AND pr.correlation_id = ur.correlation_id
             )))
       )
    )
    SELECT currency, actual_cost::text AS "actualCost", estimated_cost::text AS "estimatedCost",
           error_code AS "errorCode", status::text, ${confirmedNonDispatch} AS "confirmedNonDispatch", NULL::text AS minor, 1::bigint AS entries
      FROM provider_requests pr WHERE ${period}
       AND NOT EXISTS (SELECT FROM coverage c WHERE c.correlation_id = pr.correlation_id)
    UNION ALL
    SELECT currency, NULL, NULL, NULL, NULL, false, SUM(minor)::text, COUNT(*) FROM (
      SELECT currency, minor FROM coverage
       WHERE minor > 0 AND created_at >= ${bounds.start} AND created_at < ${bounds.end} ${channel}
      UNION ALL
      SELECT currency, CASE WHEN kind = 'DEBIT' THEN amount_minor ELSE -amount_minor END
        FROM usage_adjustments WHERE ${period}
    ) charges GROUP BY currency`);
  let consumed = 0n;
  let unconverted = 0;
  for (const row of rows) {
    const cost =
      row.minor === null
        ? classifyCost({ ...row, currency: row.currency?.trim().toUpperCase() ?? null })
        : null;
    if (cost?.kind === "UNKNOWN" || cost?.kind === "NOT_DISPATCHED") continue;
    const amount = row.minor === null ? cost?.amountMinor : BigInt(row.minor);
    if ((cost?.currency ?? row.currency) !== budget.currency || amount == null)
      unconverted += Number(row.entries);
    else consumed += amount;
  }
  return { consumed: consumed > 0n ? consumed : 0n, unconverted };
}
