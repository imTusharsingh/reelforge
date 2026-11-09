ALTER TABLE "render_pending_objects"
  ADD COLUMN "upload_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "upload_completed_at" TIMESTAMPTZ(6);
