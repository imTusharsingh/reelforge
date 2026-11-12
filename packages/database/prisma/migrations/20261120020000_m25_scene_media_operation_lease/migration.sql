-- M25 scene-media operation lease.
-- Additive only: a job-scoped in-flight exclusion claimed atomically with the
-- version token so paid create/mutation operations cannot overlap.

-- AlterTable
ALTER TABLE "scene_media_jobs" ADD COLUMN "active_operation_id" TEXT;
ALTER TABLE "scene_media_jobs" ADD COLUMN "active_operation_expires_at" TIMESTAMPTZ(6);
