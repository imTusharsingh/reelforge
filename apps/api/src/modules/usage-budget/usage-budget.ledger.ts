import { Prisma } from "@reelforge/database";
import { decimalToMinor, isCurrencyCode } from "./usage-budget.money.js";
import {
  PRE_DISPATCH_ERROR_CODES,
  type CostKind,
  type UsageCategoryValue,
} from "./usage-budget.types.js";

/**
 * M18-T01: read-only joins over the EXISTING M08 cost ledger (`provider_requests`). M18 never
 * records provider spend itself.
 *
 * Join paths (documented ledger gaps in STATUS.md):
 * - workspace / channel: `provider_requests.workspace_id` / `channel_id` directly.
 * - job (workflow run): a script call carries the M16 run correlation id, so
 *   `provider_requests.correlation_id = workflow_runs.correlation_id`; a scene-media call joins
 *   through `scene_generation_outputs.correlation_id` -> scene generation -> scene-media job, whose
 *   run is the M16 step with result_type SCENE_MEDIA_PACKAGE.
 * - video: ReelForge has no populated video id on the ledger; the script id is the video key.
 *   Scene-media rows reach it via scene_media_jobs.script_id, script rows via the run's SCRIPT step.
 * - category: the ledger has no provider kind column. Scene output kind wins; otherwise the
 *   capability/provider id is matched by keyword, else UNCATEGORIZED.
 *
 * Rows whose correlation id belongs to a live (RESERVED, unexpired) or COMMITTED M18 reservation
 * are excluded so a cost is never counted twice: the reservation carries it instead.
 */
export type LedgerRow = Readonly<{
  id: string;
  channelId: string | null;
  correlationId: string;
  providerId: string;
  capabilityId: string;
  status: string;
  errorCode: string | null;
  estimatedCost: string | null;
  actualCost: string | null;
  currency: string | null;
  createdAt: Date;
  sceneKind: string | null;
  sceneMediaJobId: string | null;
  scriptId: string | null;
  workflowRunId: string | null;
}>;

export type LedgerFilter = Readonly<{
  workspaceId: string;
  now: Date;
  channelId?: string | null;
  from?: Date;
  to?: Date;
  scriptId?: string;
  workflowRunId?: string;
}>;

type RawLedgerRow = {
  id: string;
  channel_id: string | null;
  correlation_id: string;
  provider_id: string;
  capability_id: string;
  status: string;
  error_code: string | null;
  estimated_cost: string | null;
  actual_cost: string | null;
  currency: string | null;
  created_at: Date | string;
  scene_kind: string | null;
  scene_media_job_id: string | null;
  script_id: string | null;
  workflow_run_id: string | null;
};

export type LedgerReader = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

export async function readLedgerRows(db: LedgerReader, filter: LedgerFilter): Promise<LedgerRow[]> {
  const conditions: Prisma.Sql[] = [];
  if (filter.channelId !== undefined && filter.channelId !== null)
    conditions.push(Prisma.sql`ledger.channel_id = ${filter.channelId}`);
  if (filter.from !== undefined) conditions.push(Prisma.sql`ledger.created_at >= ${filter.from}`);
  if (filter.to !== undefined) conditions.push(Prisma.sql`ledger.created_at < ${filter.to}`);
  if (filter.scriptId !== undefined)
    conditions.push(Prisma.sql`ledger.script_id = ${filter.scriptId}`);
  if (filter.workflowRunId !== undefined)
    conditions.push(Prisma.sql`ledger.workflow_run_id = ${filter.workflowRunId}`);
  const where =
    conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
  const rows = await db.$queryRaw<RawLedgerRow[]>(Prisma.sql`
    WITH ledger AS (
      SELECT pr.id::text AS id,
             pr.channel_id::text AS channel_id,
             pr.correlation_id::text AS correlation_id,
             pr.provider_id,
             pr.capability_id,
             pr.status::text AS status,
             pr.error_code,
             pr.estimated_cost::text AS estimated_cost,
             pr.actual_cost::text AS actual_cost,
             pr.currency,
             pr.created_at,
             scene.kind AS scene_kind,
             scene.job_id AS scene_media_job_id,
             COALESCE(scene.script_id, script_step.result_ref) AS script_id,
             COALESCE(run.id, scene_run.run_id) AS workflow_run_id
      FROM "provider_requests" pr
      LEFT JOIN LATERAL (
        SELECT o.kind::text AS kind, g.job_id::text AS job_id, j.script_id::text AS script_id
        FROM "scene_generation_outputs" o
        JOIN "scene_generations" g ON g.workspace_id = o.workspace_id AND g.id = o.scene_generation_id
        JOIN "scene_media_jobs" j ON j.workspace_id = g.workspace_id AND j.id = g.job_id
        WHERE o.workspace_id = pr.workspace_id AND o.correlation_id = pr.correlation_id
        LIMIT 1
      ) scene ON TRUE
      LEFT JOIN LATERAL (
        SELECT r.id::text AS id
        FROM "workflow_runs" r
        WHERE r.workspace_id = pr.workspace_id AND r.correlation_id = pr.correlation_id
        LIMIT 1
      ) run ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.run_id::text AS run_id
        FROM "workflow_steps" s
        WHERE s.workspace_id = pr.workspace_id
          AND s.result_type = 'SCENE_MEDIA_PACKAGE'
          AND s.result_ref = scene.job_id
        LIMIT 1
      ) scene_run ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.result_ref
        FROM "workflow_steps" s
        WHERE s.workspace_id = pr.workspace_id
          AND s.run_id::text = run.id
          AND s.result_type = 'SCRIPT'
        LIMIT 1
      ) script_step ON TRUE
      WHERE pr.workspace_id = ${filter.workspaceId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM "usage_reservations" ur
          WHERE ur.workspace_id = pr.workspace_id
            AND ur.correlation_id = pr.correlation_id
            AND (ur.status = 'COMMITTED' OR (ur.status = 'RESERVED' AND ur.expires_at > ${filter.now}))
        )
    )
    SELECT * FROM ledger ${where}
    ORDER BY ledger.created_at ASC, ledger.id ASC`);
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    correlationId: row.correlation_id,
    providerId: row.provider_id,
    capabilityId: row.capability_id,
    status: row.status,
    errorCode: row.error_code,
    estimatedCost: row.estimated_cost,
    actualCost: row.actual_cost,
    currency: row.currency === null ? null : row.currency.trim().toUpperCase(),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    sceneKind: row.scene_kind,
    sceneMediaJobId: row.scene_media_job_id,
    scriptId: row.script_id,
    workflowRunId: row.workflow_run_id,
  }));
}

const KEYWORDS: ReadonlyArray<readonly [UsageCategoryValue, readonly string[]]> = [
  ["TTS", ["tts", "speech", "voice", "narration", "dialogue", "audio"]],
  ["IMAGE_MEDIA", ["image", "video", "media", "scene"]],
  ["RENDER", ["render", "ffmpeg", "compos"]],
  ["PUBLISH", ["publish", "upload", "youtube", "instagram"]],
  ["ANALYTICS_API", ["analytics", "metric"]],
  ["LLM", ["llm", "text", "chat", "completion", "script", "gpt"]],
];

export function categorize(
  row: Pick<LedgerRow, "sceneKind" | "capabilityId" | "providerId">,
): UsageCategoryValue {
  if (row.sceneKind === "IMAGE" || row.sceneKind === "VIDEO") return "IMAGE_MEDIA";
  if (row.sceneKind === "NARRATION" || row.sceneKind === "DIALOGUE") return "TTS";
  const haystack = `${row.capabilityId} ${row.providerId}`.toLowerCase();
  for (const [category, words] of KEYWORDS)
    if (words.some((word) => haystack.includes(word))) return category;
  return "UNCATEGORIZED";
}

export type ClassifiedCost = Readonly<{
  kind: CostKind;
  /** Minor units in `currency`; null when the cost or currency is unknown. */
  amountMinor: bigint | null;
  currency: string | null;
}>;

/**
 * Actual cost wins. A succeeded or still-pending call without an actual cost is charged at its
 * estimate (ESTIMATED). A call that failed after dispatch without an actual cost is charged at its
 * estimate too (FAILED_ESTIMATED, "failed, charged at estimate"): the provider may have billed it,
 * and M18 fails closed. Only a row M08 marked as provably never dispatched (an errorCode in
 * PRE_DISPATCH_ERROR_CODES) is skipped (NOT_DISPATCHED). A row with neither cost is UNKNOWN.
 */
export function classifyCost(
  row: Pick<LedgerRow, "status" | "errorCode" | "estimatedCost" | "actualCost" | "currency">,
): ClassifiedCost {
  const currency = row.currency !== null && isCurrencyCode(row.currency) ? row.currency : null;
  if (row.actualCost !== null)
    return {
      kind: "ACTUAL",
      amountMinor: currency === null ? null : decimalToMinor(row.actualCost, currency),
      currency,
    };
  if (
    row.status === "FAILED" &&
    row.errorCode !== null &&
    PRE_DISPATCH_ERROR_CODES.includes(row.errorCode)
  )
    return { kind: "NOT_DISPATCHED", amountMinor: null, currency };
  if (row.estimatedCost === null) return { kind: "UNKNOWN", amountMinor: null, currency };
  const pending = row.status === "FAILED" && row.errorCode === "PENDING";
  return {
    kind: row.status === "SUCCEEDED" || pending ? "ESTIMATED" : "FAILED_ESTIMATED",
    amountMinor: currency === null ? null : decimalToMinor(row.estimatedCost, currency),
    currency,
  };
}
