ALTER TYPE "QualityReviewRunStatus" ADD VALUE 'SUPERSEDED';

ALTER TABLE "quality_review_runs"
  ADD COLUMN "superseded_at" TIMESTAMPTZ(6);

ALTER TABLE "quality_decisions"
  ADD COLUMN "override_reason" TEXT;

ALTER TABLE "quality_regeneration_requests"
  ADD COLUMN "lineage_key" TEXT;

UPDATE "quality_regeneration_requests" AS request
SET "lineage_key" = scene_media_job."script_id"::TEXT
FROM "render_jobs" AS render_job
JOIN "scene_media_jobs" AS scene_media_job
  ON scene_media_job."workspace_id" = render_job."workspace_id"
  AND scene_media_job."id" = render_job."scene_media_job_id"
WHERE request."workspace_id" = render_job."workspace_id"
  AND request."render_job_id" = render_job."id";

ALTER TABLE "quality_regeneration_requests"
  ALTER COLUMN "lineage_key" SET NOT NULL;

DROP INDEX "quality_regen_family_target_attempt_key";
DROP INDEX "quality_regen_family_target_created_idx";

CREATE UNIQUE INDEX "quality_regen_lineage_target_attempt_key"
  ON "quality_regeneration_requests"("workspace_id", "lineage_key", "target_key", "attempt");
CREATE INDEX "quality_regen_lineage_target_created_idx"
  ON "quality_regeneration_requests"("workspace_id", "lineage_key", "target_key", "created_at");
