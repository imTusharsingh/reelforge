-- M19 admin, security, audit & observability (additive only).

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'CONFIG', 'APPROVAL', 'CONNECTION', 'PUBLISHING', 'ADMIN', 'OPERATION');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "EmergencyStopScope" AS ENUM ('WORKSPACE', 'CHANNEL');

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspace_id" UUID,
    "actor_user_id" UUID,
    "category" "AuditCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT,
    "route" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "status_code" INTEGER,
    "error_code" TEXT,
    "target_ids" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "correlation_id" UUID NOT NULL,
    "trace_id" TEXT,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_stops" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" "EmergencyStopScope" NOT NULL,
    "channel_id" UUID,
    "scope_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "set_by_user_id" UUID,
    "set_at" TIMESTAMPTZ(6),
    "cleared_by_user_id" UUID,
    "cleared_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "emergency_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_occurred_at_id_idx" ON "audit_events"("workspace_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_id_idx" ON "audit_events"("occurred_at", "id");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "emergency_stops_workspace_id_active_idx" ON "emergency_stops"("workspace_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_stops_workspace_id_scope_key_key" ON "emergency_stops"("workspace_id", "scope_key");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_stops_workspace_id_id_key" ON "emergency_stops"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "emergency_stops" ADD CONSTRAINT "emergency_stops_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_stops" ADD CONSTRAINT "emergency_stops_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An emergency stop row is either the workspace scope or one channel scope, never both.
ALTER TABLE "emergency_stops" ADD CONSTRAINT "emergency_stops_scope_check" CHECK (
    ("scope" = 'WORKSPACE' AND "channel_id" IS NULL AND "scope_key" = 'workspace')
    OR ("scope" = 'CHANNEL' AND "channel_id" IS NOT NULL AND "scope_key" = 'channel:' || "channel_id"::text)
);
ALTER TABLE "emergency_stops" ADD CONSTRAINT "emergency_stops_reason_check" CHECK (
    "active" = false OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "set_by_user_id" IS NOT NULL AND "set_at" IS NOT NULL)
);

-- audit_events is strictly append-only: no UPDATE, no DELETE (not even by cascade, because the
-- table has no foreign keys), and no TRUNCATE. Removing audit rows needs a later, ADR-approved
-- migration (retention policy is still a pending decision).
CREATE FUNCTION prevent_audit_event_change() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_events rows are append-only (% rejected)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_append_only_row
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_change();

CREATE TRIGGER audit_events_append_only_truncate
    BEFORE TRUNCATE ON "audit_events"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_change();
