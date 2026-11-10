-- M16 workflow orchestration and scheduler.
-- Additive: extends the foundation workflow_runs row and adds durable
-- run/step/job/event, schedule, cursor, and limit tables.

-- CreateEnum
CREATE TYPE "WorkflowTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "WorkflowDefinitionKey" AS ENUM ('GENERATION', 'PUBLISH', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "WorkflowDispatchStatus" AS ENUM ('NOT_CONFIGURED', 'DISPATCHED');

-- CreateEnum
CREATE TYPE "WorkflowBudgetDecision" AS ENUM ('NOT_CONFIGURED', 'ALLOWED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM (
  'PENDING',
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'CANCELED',
  'SKIPPED',
  'RECONCILIATION_REQUIRED'
);

-- CreateEnum
CREATE TYPE "WorkflowJobStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'RETRY_WAIT',
  'FAILED',
  'DEAD_LETTER',
  'CANCELED'
);

-- CreateEnum
CREATE TYPE "WorkflowLeaseScope" AS ENUM ('WORKSPACE', 'CHANNEL', 'PROVIDER', 'JOB_TYPE');

-- CreateEnum
CREATE TYPE "WorkflowScheduleSlotStatus" AS ENUM ('CLAIMED', 'STARTED', 'SKIPPED');

-- AlterTable
ALTER TABLE "workflow_runs"
  ADD COLUMN "channel_id" UUID,
  ADD COLUMN "definition_key" "WorkflowDefinitionKey" NOT NULL DEFAULT 'GENERATION',
  ADD COLUMN "trigger" "WorkflowTrigger" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "triggered_by_user_id" UUID,
  ADD COLUMN "dispatch_status" "WorkflowDispatchStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN "budget_decision" "WorkflowBudgetDecision" NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN "budget_reason" TEXT,
  ADD COLUMN "input" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "next_action" TEXT,
  ADD COLUMN "paused_reason" TEXT,
  ADD COLUMN "current_step_key" TEXT,
  ADD COLUMN "last_error_code" TEXT,
  ADD COLUMN "last_error_message" TEXT,
  ADD COLUMN "started_at" TIMESTAMPTZ(6),
  ADD COLUMN "completed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "workflow_steps" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "step_key" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "WorkflowStepStatus" NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "retry_generation" INTEGER NOT NULL DEFAULT 0,
  "side_effect" BOOLEAN NOT NULL DEFAULT false,
  "idempotency_key" TEXT NOT NULL,
  "result_ref" TEXT,
  "result_type" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "next_attempt_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_jobs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "step_id" UUID NOT NULL,
  "job_id" TEXT NOT NULL,
  "queue_name" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" "WorkflowJobStatus" NOT NULL,
  "payload" JSONB NOT NULL,
  "error_code" TEXT,
  "error_message" TEXT,
  "dead_lettered_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_events" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "step_id" UUID,
  "job_id" UUID,
  "event_type" TEXT NOT NULL,
  "correlation_id" UUID NOT NULL,
  "causation_id" UUID,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_schedule_slots" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "slot_key" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "local_time" TEXT NOT NULL,
  "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
  "status" "WorkflowScheduleSlotStatus" NOT NULL,
  "reason" TEXT,
  "run_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_schedule_slots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_scheduler_cursors" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "last_slot_key" TEXT,
  "last_evaluated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_scheduler_cursors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_limit_leases" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scope" "WorkflowLeaseScope" NOT NULL,
  "scope_key" TEXT NOT NULL,
  "slot" INTEGER NOT NULL,
  "holder_id" TEXT NOT NULL,
  "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_limit_leases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_rate_counters" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scope" "WorkflowLeaseScope" NOT NULL,
  "scope_key" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_rate_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_channel_id_created_at_idx" ON "workflow_runs"("workspace_id", "channel_id", "created_at");
CREATE UNIQUE INDEX "workflow_steps_workspace_id_id_key" ON "workflow_steps"("workspace_id", "id");
CREATE UNIQUE INDEX "workflow_steps_workspace_id_run_id_step_key_key" ON "workflow_steps"("workspace_id", "run_id", "step_key");
CREATE INDEX "workflow_steps_workspace_id_status_next_attempt_at_idx" ON "workflow_steps"("workspace_id", "status", "next_attempt_at");
CREATE INDEX "workflow_steps_workspace_id_status_lease_expires_at_idx" ON "workflow_steps"("workspace_id", "status", "lease_expires_at");

CREATE UNIQUE INDEX "workflow_jobs_workspace_id_id_key" ON "workflow_jobs"("workspace_id", "id");
CREATE UNIQUE INDEX "workflow_jobs_workspace_id_job_id_key" ON "workflow_jobs"("workspace_id", "job_id");
CREATE INDEX "workflow_jobs_workspace_id_run_id_created_at_idx" ON "workflow_jobs"("workspace_id", "run_id", "created_at");
CREATE INDEX "workflow_jobs_workspace_id_status_created_at_idx" ON "workflow_jobs"("workspace_id", "status", "created_at");

CREATE INDEX "workflow_events_workspace_id_run_id_occurred_at_idx" ON "workflow_events"("workspace_id", "run_id", "occurred_at");

CREATE UNIQUE INDEX "workflow_schedule_slots_workspace_id_id_key" ON "workflow_schedule_slots"("workspace_id", "id");
CREATE UNIQUE INDEX "workflow_schedule_slots_workspace_id_channel_id_slot_key_key" ON "workflow_schedule_slots"("workspace_id", "channel_id", "slot_key");
CREATE INDEX "workflow_schedule_slots_workspace_id_scheduled_for_idx" ON "workflow_schedule_slots"("workspace_id", "scheduled_for");

CREATE UNIQUE INDEX "workflow_scheduler_cursors_workspace_id_channel_id_key" ON "workflow_scheduler_cursors"("workspace_id", "channel_id");

CREATE UNIQUE INDEX "workflow_limit_leases_workspace_id_scope_scope_key_slot_key" ON "workflow_limit_leases"("workspace_id", "scope", "scope_key", "slot");
CREATE INDEX "workflow_limit_leases_workspace_id_scope_scope_key_expires__idx" ON "workflow_limit_leases"("workspace_id", "scope", "scope_key", "expires_at");

CREATE UNIQUE INDEX "workflow_rate_counters_workspace_id_scope_scope_key_window__key" ON "workflow_rate_counters"("workspace_id", "scope", "scope_key", "window_start");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "workflow_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "workflow_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_workspace_id_step_id_fkey" FOREIGN KEY ("workspace_id", "step_id") REFERENCES "workflow_steps"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "workflow_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workspace_id_step_id_fkey" FOREIGN KEY ("workspace_id", "step_id") REFERENCES "workflow_steps"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workspace_id_job_id_fkey" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "workflow_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_schedule_slots" ADD CONSTRAINT "workflow_schedule_slots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_schedule_slots" ADD CONSTRAINT "workflow_schedule_slots_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_scheduler_cursors" ADD CONSTRAINT "workflow_scheduler_cursors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_scheduler_cursors" ADD CONSTRAINT "workflow_scheduler_cursors_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_limit_leases" ADD CONSTRAINT "workflow_limit_leases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_rate_counters" ADD CONSTRAINT "workflow_rate_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
