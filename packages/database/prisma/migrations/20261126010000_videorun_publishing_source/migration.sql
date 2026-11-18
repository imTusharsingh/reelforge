ALTER TABLE "scheduled_posts"
  ALTER COLUMN "render_job_id" DROP NOT NULL,
  ALTER COLUMN "quality_review_run_id" DROP NOT NULL;

ALTER TABLE "scheduled_posts"
  ADD COLUMN "video_run_id" UUID,
  ADD COLUMN "critic_step_id" UUID,
  ADD COLUMN "assembly_step_id" UUID;

CREATE INDEX "scheduled_posts_workspace_id_video_run_id_created_at_idx"
  ON "scheduled_posts"("workspace_id", "video_run_id", "created_at");

ALTER TABLE "scheduled_posts"
  ADD CONSTRAINT "scheduled_posts_source_check"
  CHECK (("render_job_id" IS NOT NULL AND "quality_review_run_id" IS NOT NULL AND "video_run_id" IS NULL)
      OR ("render_job_id" IS NULL AND "quality_review_run_id" IS NULL AND "video_run_id" IS NOT NULL
          AND "critic_step_id" IS NOT NULL AND "assembly_step_id" IS NOT NULL));
