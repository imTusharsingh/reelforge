CREATE TYPE "ProviderReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

CREATE TABLE "provider_budget_reservations" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "budget_id" UUID NOT NULL,
  "correlation_id" UUID,
  "period_start" DATE NOT NULL,
  "reserved_amount" DECIMAL(18,8) NOT NULL,
  "actual_cost" DECIMAL(18,8),
  "charged_cost" DECIMAL(18,8),
  "budget_applied" BOOLEAN NOT NULL DEFAULT false,
  "status" "ProviderReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "provider_budget_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_budgets_workspace_id_id_key" ON "provider_budgets"("workspace_id", "id");

CREATE UNIQUE INDEX "provider_budget_reservations_workspace_id_id_key" ON "provider_budget_reservations"("workspace_id", "id");
CREATE UNIQUE INDEX "provider_budget_reservations_workspace_id_correlation_id_key" ON "provider_budget_reservations"("workspace_id", "correlation_id");
CREATE INDEX "provider_budget_reservations_workspace_id_status_created_at_idx" ON "provider_budget_reservations"("workspace_id", "status", "created_at");

ALTER TABLE "provider_budget_reservations"
  ADD CONSTRAINT "provider_budget_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_budget_reservations_workspace_id_budget_id_fkey" FOREIGN KEY ("workspace_id", "budget_id") REFERENCES "provider_budgets"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_budget_reservations_cost_check" CHECK ("reserved_amount" >= 0 AND ("actual_cost" IS NULL OR "actual_cost" >= 0) AND ("charged_cost" IS NULL OR "charged_cost" >= 0));

CREATE UNIQUE INDEX "provider_requests_workspace_id_correlation_id_key" ON "provider_requests"("workspace_id", "correlation_id");
ALTER TABLE "provider_requests" ADD COLUMN "dispatched_prompt" TEXT;
ALTER TABLE "provider_budget_reservations" ADD CONSTRAINT "provider_budget_reservations_workspace_id_correlation_id_fkey" FOREIGN KEY ("workspace_id", "correlation_id") REFERENCES "provider_requests"("workspace_id", "correlation_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "script_revisions"
  ADD CONSTRAINT "script_revisions_workspace_id_config_snapshot_id_fkey" FOREIGN KEY ("workspace_id", "config_snapshot_id") REFERENCES "generation_config_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "script_revisions_workspace_id_prompt_snapshot_id_fkey" FOREIGN KEY ("workspace_id", "prompt_snapshot_id") REFERENCES "prompt_bundle_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "script_revisions_config_snapshot_id_idx" ON "script_revisions"("config_snapshot_id");
CREATE INDEX "script_revisions_prompt_snapshot_id_idx" ON "script_revisions"("prompt_snapshot_id");
