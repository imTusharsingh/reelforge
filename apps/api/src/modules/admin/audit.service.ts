import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  currentContext,
  currentCorrelationId,
  isUuid,
  metrics,
  redact,
  redactString,
} from "@reelforge/observability";
import { z } from "zod";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import {
  AUDIT_CATEGORIES,
  type AuditEntry,
  type AuditEventView,
  type AuditCategoryValue,
  type AuditOutcomeValue,
} from "./audit.types.js";

const auditWrites = metrics.counter("reelforge_audit_events_total", "Audit events written");
const auditFailures = metrics.counter(
  "reelforge_audit_write_failures_total",
  "Audit events that could not be written",
);

const listQuerySchema = z
  .object({
    category: z.enum(AUDIT_CATEGORIES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

type AuditRow = {
  id: string;
  occurredAt: Date;
  workspaceId: string | null;
  actorUserId: string | null;
  category: string;
  action: string;
  method: string | null;
  route: string | null;
  outcome: string;
  statusCode: number | null;
  errorCode: string | null;
  targetIds: unknown;
  metadata: unknown;
  correlationId: string;
  traceId: string | null;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toAuditView(row: AuditRow): AuditEventView {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    category: row.category as AuditCategoryValue,
    action: row.action,
    method: row.method,
    route: row.route,
    outcome: row.outcome as AuditOutcomeValue,
    statusCode: row.statusCode,
    errorCode: row.errorCode,
    targetIds: asObject(row.targetIds),
    metadata: asObject(row.metadata),
    correlationId: row.correlationId,
    traceId: row.traceId,
  };
}

/**
 * M19-T02 shared append-only audit sink. Other modules may call `record` for domain-level events;
 * the HTTP audit interceptor records every mutating request. Metadata is redacted before it is
 * stored, and the table rejects UPDATE/DELETE/TRUNCATE at the database level.
 */
@Injectable()
export class AuditService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  /** Writes one audit event. Throws if the write fails (callers decide whether to swallow). */
  public async record(entry: AuditEntry): Promise<AuditEventView> {
    const context = currentContext();
    const correlationId = isUuid(entry.correlationId)
      ? entry.correlationId
      : (context?.correlationId ?? currentCorrelationId());
    try {
      const row = await this.db.auditEvent.create({
        data: {
          ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
          workspaceId: isUuid(entry.workspaceId) ? entry.workspaceId : null,
          actorUserId: isUuid(entry.actorUserId) ? entry.actorUserId : null,
          category: entry.category,
          action: redactString(entry.action).slice(0, 200),
          method: entry.method ?? null,
          route:
            entry.route === undefined || entry.route === null ? null : entry.route.slice(0, 300),
          outcome: entry.outcome,
          statusCode: entry.statusCode ?? null,
          errorCode:
            entry.errorCode === undefined || entry.errorCode === null
              ? null
              : redactString(entry.errorCode).slice(0, 120),
          targetIds: (entry.targetIds ?? {}) as Record<string, string>,
          metadata: redact(entry.metadata ?? {}) as Record<string, string>,
          correlationId,
          traceId: context?.traceId ?? null,
        },
      });
      auditWrites.inc({ category: entry.category, outcome: entry.outcome });
      return toAuditView(row);
    } catch (error) {
      auditFailures.inc({ category: entry.category });
      throw error;
    }
  }

  /** OWNER-only read of this workspace's audit history, newest first. */
  public async list(context: WorkspaceContext, query: unknown): Promise<AuditEventView[]> {
    if (context.role !== "OWNER") throw new ForbiddenException("Owner permission required");
    const parsed = listQuerySchema.parse(query ?? {});
    const rows = await this.db.auditEvent.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(parsed.category === undefined ? {} : { category: parsed.category }),
        ...(parsed.before === undefined ? {} : { occurredAt: { lt: new Date(parsed.before) } }),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: parsed.limit,
    });
    return rows.map(toAuditView);
  }
}
