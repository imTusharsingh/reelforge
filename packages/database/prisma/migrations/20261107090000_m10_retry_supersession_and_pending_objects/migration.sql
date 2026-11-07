ALTER TABLE "render_jobs" ADD COLUMN "retry_superseded_at" TIMESTAMPTZ(6);

CREATE TABLE "render_pending_objects" (
  "workspace_id" UUID NOT NULL,
  "object_key" TEXT NOT NULL,
  "render_job_id" UUID NOT NULL,
  "lease_token" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "render_pending_objects_pkey" PRIMARY KEY ("workspace_id", "object_key")
);

CREATE INDEX "render_pending_objects_workspace_id_render_job_id_idx" ON "render_pending_objects"("workspace_id", "render_job_id");
CREATE INDEX "render_pending_objects_lease_token_idx" ON "render_pending_objects"("lease_token");

ALTER TABLE "render_pending_objects" ADD CONSTRAINT "render_pending_objects_job_fkey" FOREIGN KEY ("workspace_id", "render_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
