-- M16 review fixes (additive): external-wait step state, separate limit-wait and
-- external-poll counters (they never consume attempts), and a per-step external deadline.

-- AlterEnum
ALTER TYPE "WorkflowStepStatus" ADD VALUE 'WAITING_EXTERNAL';

-- AlterTable
ALTER TABLE "workflow_steps"
  ADD COLUMN "limit_waits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "external_polls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "external_deadline_at" TIMESTAMPTZ(6);
