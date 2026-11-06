ALTER TABLE "render_jobs"
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "max_retries" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "scheduled_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retry_backoff_ms" INTEGER NOT NULL DEFAULT 250,
  ADD COLUMN "expired_at" TIMESTAMPTZ(6);
CREATE INDEX "render_jobs_status_next_attempt_at_idx" ON "render_jobs"("status", "next_attempt_at");
CREATE INDEX "render_jobs_lease_expires_at_idx" ON "render_jobs"("lease_expires_at");
CREATE INDEX "render_artifacts_retained_until_idx" ON "render_artifacts"("retained_until");
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_retry_policy_check" CHECK ("max_retries" = 3 AND "retry_backoff_ms" = 250);
