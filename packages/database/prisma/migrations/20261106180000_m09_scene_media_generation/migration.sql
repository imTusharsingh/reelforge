CREATE TYPE "SceneMediaJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');
CREATE TYPE "SceneGenerationStatus" AS ENUM ('QUEUED', 'SUBMITTED', 'PROVIDER_PROCESSING', 'SUCCEEDED', 'RETRY_WAIT', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELED');
CREATE TYPE "SceneMediaKind" AS ENUM ('IMAGE', 'VIDEO', 'NARRATION', 'DIALOGUE');
CREATE TYPE "SceneOutputStatus" AS ENUM ('QUEUED', 'SUCCEEDED', 'REUSED', 'FAILED_RETRYABLE', 'FAILED_FINAL');

CREATE TABLE "scene_media_jobs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "script_id" UUID NOT NULL,
  "script_revision" INTEGER NOT NULL,
  "channel_id" UUID,
  "idempotency_key" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '1.0',
  "status" "SceneMediaJobStatus" NOT NULL DEFAULT 'QUEUED',
  "requested_outputs" JSONB NOT NULL,
  "config_snapshot_id" UUID NOT NULL,
  "prompt_snapshot_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "scene_media_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scene_generations" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "scene_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "scene_version" INTEGER NOT NULL,
  "status" "SceneGenerationStatus" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "resolved_prompt" TEXT NOT NULL,
  "source_refs" JSONB NOT NULL,
  "active_slot" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "scene_generations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scene_generation_outputs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scene_generation_id" UUID NOT NULL,
  "kind" "SceneMediaKind" NOT NULL,
  "status" "SceneOutputStatus" NOT NULL,
  "asset_id" UUID,
  "asset_version" INTEGER,
  "provider_job_id" TEXT,
  "provider_asset_id" TEXT,
  "correlation_id" UUID,
  "media_type" TEXT,
  "byte_size" INTEGER,
  "checksum_sha256" TEXT,
  "metadata" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "reused_from_output_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "scene_generation_outputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scene_media_jobs_workspace_id_id_key" ON "scene_media_jobs"("workspace_id", "id");
CREATE UNIQUE INDEX "scene_media_jobs_idempotency_key" ON "scene_media_jobs"("workspace_id", "idempotency_key");
CREATE INDEX "scene_media_jobs_workspace_id_script_id_created_at_idx" ON "scene_media_jobs"("workspace_id", "script_id", "created_at");

CREATE UNIQUE INDEX "scene_generations_workspace_id_id_key" ON "scene_generations"("workspace_id", "id");
CREATE UNIQUE INDEX "scene_generations_scene_version_key" ON "scene_generations"("workspace_id", "job_id", "scene_id", "scene_version");
CREATE UNIQUE INDEX "scene_generations_idempotency_key" ON "scene_generations"("workspace_id", "idempotency_key");
CREATE UNIQUE INDEX "scene_generations_active_slot_key" ON "scene_generations"("workspace_id", "job_id", "scene_id", "active_slot");
CREATE INDEX "scene_generations_workspace_id_job_id_ordinal_idx" ON "scene_generations"("workspace_id", "job_id", "ordinal");

CREATE UNIQUE INDEX "scene_generation_outputs_workspace_id_id_key" ON "scene_generation_outputs"("workspace_id", "id");
CREATE UNIQUE INDEX "scene_outputs_generation_kind_key" ON "scene_generation_outputs"("workspace_id", "scene_generation_id", "kind");
CREATE INDEX "scene_generation_outputs_workspace_id_asset_id_idx" ON "scene_generation_outputs"("workspace_id", "asset_id");

ALTER TABLE "scene_media_jobs"
  ADD CONSTRAINT "scene_media_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_script_fkey" FOREIGN KEY ("workspace_id", "script_id") REFERENCES "scripts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_channel_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_config_fkey" FOREIGN KEY ("workspace_id", "config_snapshot_id") REFERENCES "generation_config_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_prompt_fkey" FOREIGN KEY ("workspace_id", "prompt_snapshot_id") REFERENCES "prompt_bundle_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_created_by_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_media_jobs_key_check" CHECK (char_length("idempotency_key") BETWEEN 1 AND 200),
  ADD CONSTRAINT "scene_media_jobs_revision_check" CHECK ("script_revision" >= 1),
  ADD CONSTRAINT "scene_media_jobs_schema_check" CHECK (char_length("schema_version") > 0);

ALTER TABLE "scene_generations"
  ADD CONSTRAINT "scene_generations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_generations_job_fkey" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "scene_media_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_generations_slot_check" CHECK ("active_slot" IS NULL OR "active_slot" = 1),
  ADD CONSTRAINT "scene_generations_version_check" CHECK ("scene_version" >= 1 AND "ordinal" >= 0),
  ADD CONSTRAINT "scene_generations_key_check" CHECK (char_length("idempotency_key") > 0 AND char_length("scene_id") > 0);

ALTER TABLE "scene_generation_outputs"
  ADD CONSTRAINT "scene_outputs_workspace_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_outputs_generation_fkey" FOREIGN KEY ("workspace_id", "scene_generation_id") REFERENCES "scene_generations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_outputs_asset_fkey" FOREIGN KEY ("workspace_id", "asset_id") REFERENCES "assets"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_outputs_request_fkey" FOREIGN KEY ("workspace_id", "correlation_id") REFERENCES "provider_requests"("workspace_id", "correlation_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_outputs_reused_from_fkey" FOREIGN KEY ("workspace_id", "reused_from_output_id") REFERENCES "scene_generation_outputs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scene_outputs_size_check" CHECK ("byte_size" IS NULL OR "byte_size" > 0),
  ADD CONSTRAINT "scene_outputs_success_media_check" CHECK (
    "status" NOT IN ('SUCCEEDED', 'REUSED')
    OR (
      "asset_id" IS NOT NULL
      AND "asset_version" >= 1
      AND "byte_size" > 0
      AND "checksum_sha256" IS NOT NULL
      AND char_length("checksum_sha256") = 64
      AND "provider_asset_id" IS NOT NULL
      AND char_length("provider_asset_id") > 0
      AND "media_type" IS NOT NULL
      AND char_length("media_type") > 0
    )
  );
