-- M18 usage, budget and billing foundation (additive only).

-- CreateEnum
CREATE TYPE "UsageCategory" AS ENUM ('LLM', 'TTS', 'IMAGE_MEDIA', 'RENDER', 'PUBLISH', 'ANALYTICS_API', 'UNCATEGORIZED');

-- CreateEnum
CREATE TYPE "UsageReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "UsageAdjustmentKind" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "UsageAuditAction" AS ENUM ('BUDGET_CREATED', 'LIMIT_CHANGED', 'CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "usage_budgets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID,
    "scope_key" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "daily_limit_minor" BIGINT,
    "monthly_limit_minor" BIGINT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "category" "UsageCategory" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "committed_minor" BIGINT,
    "status" "UsageReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "correlation_id" UUID,
    "workflow_run_id" UUID,
    "script_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "committed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "release_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_adjustments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID,
    "kind" "UsageAdjustmentKind" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_audit_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "action" "UsageAuditAction" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "correlation_id" UUID NOT NULL,
    "budget_id" UUID,
    "adjustment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_budgets_workspace_id_id_key" ON "usage_budgets"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_budgets_workspace_id_scope_key_key" ON "usage_budgets"("workspace_id", "scope_key");

-- CreateIndex
CREATE INDEX "usage_reservations_workspace_id_created_at_idx" ON "usage_reservations"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_reservations_workspace_id_correlation_id_idx" ON "usage_reservations"("workspace_id", "correlation_id");

-- CreateIndex
CREATE INDEX "usage_reservations_status_expires_at_idx" ON "usage_reservations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_reservations_workspace_id_id_key" ON "usage_reservations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_reservations_workspace_id_idempotency_key_key" ON "usage_reservations"("workspace_id", "idempotency_key");

-- One reservation per correlation id, so a provider call is never held (and counted) twice.
-- Partial index: Prisma cannot express it, so it lives only in SQL.
CREATE UNIQUE INDEX "usage_reservations_workspace_id_correlation_id_unique" ON "usage_reservations"("workspace_id", "correlation_id") WHERE "correlation_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "usage_adjustments_workspace_id_created_at_idx" ON "usage_adjustments"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_adjustments_workspace_id_id_key" ON "usage_adjustments"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "usage_audit_records_workspace_id_created_at_idx" ON "usage_audit_records"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_audit_records_workspace_id_id_key" ON "usage_audit_records"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "usage_budgets" ADD CONSTRAINT "usage_budgets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_budgets" ADD CONSTRAINT "usage_budgets_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_audit_records" ADD CONSTRAINT "usage_audit_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Money is integer minor units; amounts and limits are never negative.
ALTER TABLE "usage_budgets"
    ADD CONSTRAINT "usage_budgets_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "usage_budgets_limits_check" CHECK (
        ("daily_limit_minor" IS NULL OR "daily_limit_minor" >= 0)
        AND ("monthly_limit_minor" IS NULL OR "monthly_limit_minor" >= 0)
        AND ("daily_limit_minor" IS NOT NULL OR "monthly_limit_minor" IS NOT NULL)
    ),
    ADD CONSTRAINT "usage_budgets_scope_check" CHECK (
        ("channel_id" IS NULL AND "scope_key" = 'WORKSPACE')
        OR ("channel_id" IS NOT NULL AND "scope_key" = "channel_id"::text)
    );

ALTER TABLE "usage_reservations"
    ADD CONSTRAINT "usage_reservations_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "usage_reservations_amount_check" CHECK (
        "amount_minor" >= 0 AND ("committed_minor" IS NULL OR "committed_minor" >= 0)
    ),
    ADD CONSTRAINT "usage_reservations_commit_check" CHECK (
        ("status" = 'COMMITTED') = ("committed_minor" IS NOT NULL AND "committed_at" IS NOT NULL)
    );

ALTER TABLE "usage_adjustments"
    ADD CONSTRAINT "usage_adjustments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "usage_adjustments_amount_check" CHECK ("amount_minor" > 0);

-- Adjustments and audit records are append-only. A direct UPDATE or DELETE fails; only a
-- cascade from deleting the owning workspace (pg_trigger_depth() > 1) may remove rows.
CREATE FUNCTION prevent_usage_append_only_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER usage_adjustments_append_only
    BEFORE UPDATE OR DELETE ON "usage_adjustments"
    FOR EACH ROW EXECUTE FUNCTION prevent_usage_append_only_change();

CREATE TRIGGER usage_audit_records_append_only
    BEFORE UPDATE OR DELETE ON "usage_audit_records"
    FOR EACH ROW EXECUTE FUNCTION prevent_usage_append_only_change();
