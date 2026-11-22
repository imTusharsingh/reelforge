import { Prisma } from "@reelforge/database";
import {
  classifyCost,
  confirmedNonDispatch,
  type LedgerReader,
  type LedgerRow,
} from "./usage-budget.ledger.js";
import type { PeriodBounds } from "./usage-budget.time.js";

type Price = Pick<LedgerRow, "currency" | "actualCost" | "estimatedCost" | "errorCode" | "status">;

const committedShotExposure = Prisma.sql`CASE
  WHEN status = 'COMMITTED' AND EXISTS (
    SELECT FROM video_run_steps s
     WHERE s.workspace_id = ur.workspace_id
       AND s.id = ur.correlation_id
       AND s."key" LIKE 'shot-%'
  ) THEN GREATEST(committed_minor, amount_minor)
  WHEN status = 'COMMITTED' THEN committed_minor
  ELSE amount_minor
END`;

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
      SELECT correlation_id, currency, created_at, channel_id,
             ${committedShotExposure} AS minor
        FROM usage_reservations ur
       WHERE workspace_id = ${budget.workspaceId}::uuid AND (
         status = 'COMMITTED' OR (status = 'RESERVED' AND expires_at > ${now})
         OR (status IN ('RESERVED', 'EXPIRED') AND EXISTS (
           SELECT FROM video_run_steps s WHERE s.workspace_id = ur.workspace_id
             AND s.id = ur.correlation_id AND ur.idempotency_key = 'm08:' || s.idempotency_key
             AND s.state IN ('RUNNING','WAITING_EXTERNAL')
         ) AND NOT EXISTS (
           SELECT FROM provider_requests pr WHERE pr.workspace_id = ur.workspace_id
             AND pr.correlation_id = ur.correlation_id
         ))
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
