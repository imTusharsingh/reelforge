CREATE TYPE "RenderJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELED');
CREATE TABLE "render_jobs" (
  "id" UUID NOT NULL, "workspace_id" UUID NOT NULL, "scene_media_job_id" UUID NOT NULL,
  "parent_job_id" UUID, "idempotency_key" TEXT NOT NULL,
  "status" "RenderJobStatus" NOT NULL DEFAULT 'QUEUED', "attempt" INTEGER NOT NULL DEFAULT 0,
  "schema_version" TEXT NOT NULL DEFAULT '1.0', "input_fingerprint" TEXT NOT NULL, "input" JSONB NOT NULL,
  "retention_days" INTEGER NOT NULL DEFAULT 90, "cancel_requested_at" TIMESTAMPTZ(6),
  "error_code" TEXT, "error_message" TEXT, "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "render_artifacts" (
  "id" UUID NOT NULL, "workspace_id" UUID NOT NULL, "render_job_id" UUID NOT NULL,
  "kind" TEXT NOT NULL, "asset_id" UUID NOT NULL, "asset_version" INTEGER NOT NULL,
  "object_key" TEXT NOT NULL, "media_type" TEXT NOT NULL, "byte_size" INTEGER NOT NULL,
  "checksum_sha256" TEXT NOT NULL, "metadata" JSONB, "retained_until" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "render_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "render_jobs_workspace_id_id_key" ON "render_jobs"("workspace_id", "id");
CREATE UNIQUE INDEX "render_jobs_idempotency_key" ON "render_jobs"("workspace_id", "idempotency_key");
CREATE INDEX "render_jobs_workspace_id_created_at_idx" ON "render_jobs"("workspace_id", "created_at");
CREATE INDEX "render_jobs_workspace_id_status_created_at_idx" ON "render_jobs"("workspace_id", "status", "created_at");
CREATE UNIQUE INDEX "render_artifacts_workspace_id_id_key" ON "render_artifacts"("workspace_id", "id");
CREATE UNIQUE INDEX "render_artifacts_unique_key" ON "render_artifacts"("workspace_id", "render_job_id", "kind", "asset_id");
CREATE UNIQUE INDEX "render_artifacts_object_key" ON "render_artifacts"("workspace_id", "object_key");
CREATE INDEX "render_artifacts_workspace_id_render_job_id_created_at_idx" ON "render_artifacts"("workspace_id", "render_job_id", "created_at");
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_scene_fkey" FOREIGN KEY ("workspace_id", "scene_media_job_id") REFERENCES "scene_media_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_parent_fkey" FOREIGN KEY ("workspace_id", "parent_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_creator_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_artifacts" ADD CONSTRAINT "render_artifacts_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "render_artifacts" ADD CONSTRAINT "render_artifacts_job_fkey" FOREIGN KEY ("workspace_id", "render_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "render_artifacts" ADD CONSTRAINT "render_artifacts_asset_fkey" FOREIGN KEY ("workspace_id", "asset_id") REFERENCES "assets"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_input_check" CHECK (char_length("idempotency_key") BETWEEN 1 AND 200 AND char_length("input_fingerprint") = 64 AND "schema_version" = '1.0' AND "retention_days" BETWEEN 1 AND 3650 AND "attempt" >= 0);
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_terminal_check" CHECK ("status" NOT IN ('SUCCEEDED', 'CANCELED') OR ("error_code" IS NULL AND "cancel_requested_at" IS NULL) OR "status" = 'CANCELED');
ALTER TABLE "render_artifacts" ADD CONSTRAINT "render_artifacts_kind_check" CHECK ("kind" IN ('VIDEO', 'MANIFEST', 'COVER'));
ALTER TABLE "render_artifacts" ADD CONSTRAINT "render_artifacts_media_check" CHECK ("byte_size" > 0 AND "asset_version" > 0 AND char_length("checksum_sha256") = 64 AND char_length("object_key") > 0 AND char_length("media_type") > 0);
