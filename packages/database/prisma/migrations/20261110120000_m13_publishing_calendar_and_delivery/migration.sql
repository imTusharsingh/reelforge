-- CreateEnum
CREATE TYPE "PublishingDisclosureDecision" AS ENUM ('DISCLOSE', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "PublishAttemptStatus" AS ENUM ('STARTED', 'UPLOADING', 'REMOTE_PROCESSING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'RECONCILIATION_REQUIRED');

-- CreateTable
CREATE TABLE "scheduled_posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "render_job_id" UUID NOT NULL,
    "quality_review_run_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "scheduled_at" TIMESTAMPTZ(6),
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "disclosure_decision" "PublishingDisclosureDecision" NOT NULL,
    "disclosure_text" TEXT,
    "disclosure_reason" TEXT NOT NULL,
    "manually_authorized_at" TIMESTAMPTZ(6),
    "manually_authorized_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduled_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_destinations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scheduled_post_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "metadata" JSONB NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "idempotency_key" TEXT NOT NULL,
    "remote_post_id" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "publishing_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "idempotency_key" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "publish_job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "PublishAttemptStatus" NOT NULL,
    "session_ciphertext" TEXT,
    "session_nonce" TEXT,
    "session_tag" TEXT,
    "session_key_version" TEXT,
    "total_bytes" BIGINT,
    "confirmed_bytes" BIGINT NOT NULL DEFAULT 0,
    "remote_post_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_posts_workspace_id_channel_id_scheduled_at_status_idx" ON "scheduled_posts"("workspace_id", "channel_id", "scheduled_at", "status");

-- CreateIndex
CREATE INDEX "scheduled_posts_workspace_id_render_job_id_created_at_idx" ON "scheduled_posts"("workspace_id", "render_job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_posts_workspace_id_id_key" ON "scheduled_posts"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "publishing_destinations_workspace_id_status_created_at_idx" ON "publishing_destinations"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_destinations_workspace_id_id_key" ON "publishing_destinations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_destinations_workspace_id_scheduled_post_id_soci_key" ON "publishing_destinations"("workspace_id", "scheduled_post_id", "social_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_destinations_workspace_id_idempotency_key_key" ON "publishing_destinations"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "publish_jobs_workspace_id_status_next_attempt_at_idx" ON "publish_jobs"("workspace_id", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "publish_jobs_workspace_id_id_key" ON "publish_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_jobs_workspace_id_destination_id_key" ON "publish_jobs"("workspace_id", "destination_id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_jobs_workspace_id_idempotency_key_key" ON "publish_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "publish_attempts_workspace_id_publish_job_id_started_at_idx" ON "publish_attempts"("workspace_id", "publish_job_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_workspace_id_id_key" ON "publish_attempts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_workspace_id_publish_job_id_attempt_number_key" ON "publish_attempts"("workspace_id", "publish_job_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_workspace_id_idempotency_key_key" ON "publish_attempts"("workspace_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_render_job_id_fkey" FOREIGN KEY ("workspace_id", "render_job_id") REFERENCES "render_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_quality_review_run_id_fkey" FOREIGN KEY ("workspace_id", "quality_review_run_id") REFERENCES "quality_review_runs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_manually_authorized_by_user_id_fkey" FOREIGN KEY ("manually_authorized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_destinations" ADD CONSTRAINT "publishing_destinations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_destinations" ADD CONSTRAINT "publishing_destinations_workspace_id_scheduled_post_id_fkey" FOREIGN KEY ("workspace_id", "scheduled_post_id") REFERENCES "scheduled_posts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_destinations" ADD CONSTRAINT "publishing_destinations_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_workspace_id_destination_id_fkey" FOREIGN KEY ("workspace_id", "destination_id") REFERENCES "publishing_destinations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_workspace_id_publish_job_id_fkey" FOREIGN KEY ("workspace_id", "publish_job_id") REFERENCES "publish_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
