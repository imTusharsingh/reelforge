-- M25 production job discovery and safe scene mutation contracts.
-- Additive only: an observed-version token for scene media jobs and a
-- workspace/job-scoped idempotency ledger for scene mutations.

-- CreateEnum
CREATE TYPE "SceneMediaMutationOperation" AS ENUM ('RETRY', 'REGENERATE', 'REPLACE');

-- CreateEnum
CREATE TYPE "SceneMediaMutationStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "scene_media_jobs" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "scene_media_mutations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "operation" "SceneMediaMutationOperation" NOT NULL,
    "status" "SceneMediaMutationStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "idempotency_key" TEXT NOT NULL,
    "expected_job_version" INTEGER NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scene_ids" TEXT[],
    "scene_version_before" INTEGER NOT NULL,
    "scene_version_after" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scene_media_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scene_media_mutations_workspace_id_id_key" ON "scene_media_mutations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_media_mutations_idempotency_key" ON "scene_media_mutations"("workspace_id", "job_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "scene_media_mutations_workspace_id_job_id_created_at_idx" ON "scene_media_mutations"("workspace_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_media_mutations_workspace_id_status_updated_at_idx" ON "scene_media_mutations"("workspace_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "scene_media_jobs_workspace_id_created_at_idx" ON "scene_media_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_media_jobs_workspace_id_channel_id_created_at_idx" ON "scene_media_jobs"("workspace_id", "channel_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_media_jobs_workspace_id_status_updated_at_idx" ON "scene_media_jobs"("workspace_id", "status", "updated_at");

-- AddForeignKey
ALTER TABLE "scene_media_mutations" ADD CONSTRAINT "scene_media_mutations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_media_mutations" ADD CONSTRAINT "scene_media_mutations_workspace_id_job_id_fkey" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "scene_media_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_media_mutations" ADD CONSTRAINT "scene_media_mutations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
