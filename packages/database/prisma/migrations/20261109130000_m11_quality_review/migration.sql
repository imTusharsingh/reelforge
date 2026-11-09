CREATE TYPE "QualityReviewRunStatus" AS ENUM (
  'BLOCKED',
  'AI_REVIEW_UNAVAILABLE',
  'REVIEW_REQUIRED',
  'AUTO_APPROVED',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED'
);
CREATE TYPE "QualityDecisionAction" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CHANGES');
CREATE TYPE "QualityRegenerationStage" AS ENUM ('SCENE', 'SCRIPT', 'RENDER');

CREATE TABLE "quality_review_runs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "render_job_id" UUID NOT NULL,
  "render_family_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "status" "QualityReviewRunStatus" NOT NULL,
  "gate_summary" JSONB NOT NULL,
  "scorecard" JSONB,
  "policy_snapshot" JSONB NOT NULL,
  "disclosures" JSONB NOT NULL,
  "limitations" JSONB NOT NULL,
  "model_version" TEXT,
  "prompt_version" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quality_review_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quality_decisions" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "review_run_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "action" "QualityDecisionAction" NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quality_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quality_regeneration_requests" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "review_run_id" UUID NOT NULL,
  "render_job_id" UUID NOT NULL,
  "render_family_id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "stage" "QualityRegenerationStage" NOT NULL,
  "target_key" TEXT NOT NULL,
  "scene_id" TEXT,
  "attempt" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quality_regeneration_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quality_review_runs_workspace_id_id_key" ON "quality_review_runs"("workspace_id", "id");
CREATE INDEX "quality_review_runs_workspace_id_status_created_at_idx" ON "quality_review_runs"("workspace_id", "status", "created_at");
CREATE INDEX "quality_review_runs_workspace_id_render_job_id_created_at_idx" ON "quality_review_runs"("workspace_id", "render_job_id", "created_at");
CREATE UNIQUE INDEX "quality_decisions_workspace_id_id_key" ON "quality_decisions"("workspace_id", "id");
CREATE INDEX "quality_decisions_workspace_id_review_run_id_created_at_idx" ON "quality_decisions"("workspace_id", "review_run_id", "created_at");
CREATE UNIQUE INDEX "quality_regeneration_requests_decision_id_key" ON "quality_regeneration_requests"("decision_id");
CREATE UNIQUE INDEX "quality_regeneration_requests_workspace_id_decision_id_key" ON "quality_regeneration_requests"("workspace_id", "decision_id");
CREATE UNIQUE INDEX "quality_regen_family_target_attempt_key" ON "quality_regeneration_requests"("workspace_id", "render_family_id", "target_key", "attempt");
CREATE INDEX "quality_regen_family_target_created_idx" ON "quality_regeneration_requests"("workspace_id", "render_family_id", "target_key", "created_at");

ALTER TABLE "quality_review_runs"
  ADD CONSTRAINT "quality_review_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_review_runs"
  ADD CONSTRAINT "quality_review_runs_workspace_id_render_job_id_fkey"
  FOREIGN KEY ("workspace_id", "render_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_review_runs"
  ADD CONSTRAINT "quality_review_runs_workspace_id_render_family_id_fkey"
  FOREIGN KEY ("workspace_id", "render_family_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_review_runs"
  ADD CONSTRAINT "quality_review_runs_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_decisions"
  ADD CONSTRAINT "quality_decisions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_decisions"
  ADD CONSTRAINT "quality_decisions_workspace_id_review_run_id_fkey"
  FOREIGN KEY ("workspace_id", "review_run_id") REFERENCES "quality_review_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_decisions"
  ADD CONSTRAINT "quality_decisions_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_workspace_id_review_run_id_fkey"
  FOREIGN KEY ("workspace_id", "review_run_id") REFERENCES "quality_review_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_workspace_id_render_job_id_fkey"
  FOREIGN KEY ("workspace_id", "render_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_workspace_id_render_family_i_fkey"
  FOREIGN KEY ("workspace_id", "render_family_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_workspace_id_decision_id_fkey"
  FOREIGN KEY ("workspace_id", "decision_id") REFERENCES "quality_decisions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quality_review_runs"
  ADD CONSTRAINT "quality_review_runs_score_check"
  CHECK ("scorecard" IS NULL OR jsonb_typeof("scorecard") = 'object');
ALTER TABLE "quality_decisions"
  ADD CONSTRAINT "quality_decisions_reason_check"
  CHECK (char_length(btrim("reason")) BETWEEN 1 AND 4000);
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_attempt_check"
  CHECK ("attempt" BETWEEN 1 AND 3);
ALTER TABLE "quality_regeneration_requests"
  ADD CONSTRAINT "quality_regeneration_requests_target_check"
  CHECK (
    ("stage" = 'SCENE' AND "scene_id" IS NOT NULL AND "target_key" = 'scene:' || "scene_id")
    OR ("stage" = 'SCRIPT' AND "scene_id" IS NULL AND "target_key" = 'script')
    OR ("stage" = 'RENDER' AND "scene_id" IS NULL AND "target_key" = 'render')
  );
