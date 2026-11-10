import { SetMetadata } from "@nestjs/common";

/** M19-T02 audit categories. The five required classes plus ADMIN (M19 actions) and OPERATION. */
export const AUDIT_CATEGORIES = [
  "AUTH",
  "CONFIG",
  "APPROVAL",
  "CONNECTION",
  "PUBLISHING",
  "ADMIN",
  "OPERATION",
] as const;
export type AuditCategoryValue = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_OUTCOMES = ["SUCCESS", "FAILURE", "DENIED"] as const;
export type AuditOutcomeValue = (typeof AUDIT_OUTCOMES)[number];

export type AuditEntry = Readonly<{
  workspaceId: string | null;
  actorUserId: string | null;
  category: AuditCategoryValue;
  action: string;
  method?: string | null;
  route?: string | null;
  outcome: AuditOutcomeValue;
  statusCode?: number | null;
  errorCode?: string | null;
  targetIds?: Readonly<Record<string, string>>;
  metadata?: Readonly<Record<string, unknown>>;
  correlationId?: string;
  occurredAt?: Date;
}>;

export type AuditEventView = Readonly<{
  id: string;
  occurredAt: string;
  workspaceId: string | null;
  actorUserId: string | null;
  category: AuditCategoryValue;
  action: string;
  method: string | null;
  route: string | null;
  outcome: AuditOutcomeValue;
  statusCode: number | null;
  errorCode: string | null;
  targetIds: Record<string, unknown>;
  metadata: Record<string, unknown>;
  correlationId: string;
  traceId: string | null;
}>;

export const SKIP_HTTP_AUDIT = "reelforge:skip-http-audit";

/** Marks a handler that writes its own, richer audit record (so the HTTP audit does not repeat it). */
export const SkipHttpAudit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_HTTP_AUDIT, true);
