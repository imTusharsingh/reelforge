-- CreateEnum
CREATE TYPE "AnalyticsGranularity" AS ENUM ('CHANNEL', 'VIDEO');

-- CreateEnum
CREATE TYPE "MetricCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MetricAvailability" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MetricCollectionJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED_FINAL', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "MetricCollectionRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "analytics_metric_definitions" (
    "id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "account_eligibility" TEXT NOT NULL,
    "required_scopes" TEXT[],
    "granularities" "AnalyticsGranularity"[],
    "source_api" TEXT NOT NULL,
    "documentation_url" TEXT NOT NULL,
    "availability_notes" TEXT NOT NULL,
    "verified_at" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_metric_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_collection_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" "MetricCollectionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "metric_collection_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_collection_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "MetricCollectionRunStatus" NOT NULL,
    "source_api" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "completeness" "MetricCompleteness",
    "snapshot_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "metric_collection_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_metric_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "metric_definition_id" UUID NOT NULL,
    "entity_granularity" "AnalyticsGranularity" NOT NULL,
    "remote_entity_id" TEXT,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,
    "source_api" TEXT NOT NULL,
    "completeness" "MetricCompleteness" NOT NULL,
    "availability" "MetricAvailability" NOT NULL,
    "unavailable_reason" TEXT,
    "value" DECIMAL(30,10),
    "supersedes_snapshot_id" UUID,

    CONSTRAINT "analytics_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_metric_definitions_platform_key_key" ON "analytics_metric_definitions"("platform", "key");

-- CreateIndex
CREATE INDEX "metric_collection_jobs_workspace_id_status_next_attempt_at_idx" ON "metric_collection_jobs"("workspace_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "metric_collection_jobs_workspace_id_channel_id_created_at_idx" ON "metric_collection_jobs"("workspace_id", "channel_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "metric_collection_jobs_workspace_id_id_key" ON "metric_collection_jobs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "metric_collection_runs_workspace_id_started_at_idx" ON "metric_collection_runs"("workspace_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "metric_collection_runs_workspace_id_id_key" ON "metric_collection_runs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_collection_runs_job_id_attempt_key" ON "metric_collection_runs"("job_id", "attempt");

-- CreateIndex
CREATE INDEX "analytics_metric_snapshots_workspace_id_channel_id_period_s_idx" ON "analytics_metric_snapshots"("workspace_id", "channel_id", "period_start", "period_end", "collected_at");

-- CreateIndex
CREATE INDEX "analytics_metric_snapshots_workspace_id_social_account_id_m_idx" ON "analytics_metric_snapshots"("workspace_id", "social_account_id", "metric_definition_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "analytics_metric_snapshots_workspace_id_entity_granularity__idx" ON "analytics_metric_snapshots"("workspace_id", "entity_granularity", "remote_entity_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_metric_snapshots_workspace_id_id_key" ON "analytics_metric_snapshots"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "metric_collection_jobs" ADD CONSTRAINT "metric_collection_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_collection_jobs" ADD CONSTRAINT "metric_collection_jobs_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_collection_jobs" ADD CONSTRAINT "metric_collection_jobs_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_collection_jobs" ADD CONSTRAINT "metric_collection_jobs_workspace_id_requested_by_user_id_fkey" FOREIGN KEY ("workspace_id", "requested_by_user_id") REFERENCES "workspace_memberships"("workspace_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_collection_runs" ADD CONSTRAINT "metric_collection_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_collection_runs" ADD CONSTRAINT "metric_collection_runs_workspace_id_job_id_fkey" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "metric_collection_jobs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "metric_collection_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_metric_definition_id_fkey" FOREIGN KEY ("metric_definition_id") REFERENCES "analytics_metric_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_metric_snapshots" ADD CONSTRAINT "analytics_metric_snapshots_workspace_id_supersedes_snapsho_fkey" FOREIGN KEY ("workspace_id", "supersedes_snapshot_id") REFERENCES "analytics_metric_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "metric_collection_jobs"
    ADD CONSTRAINT "metric_collection_jobs_date_range_check"
    CHECK ("start_date" <= "end_date"),
    ADD CONSTRAINT "metric_collection_jobs_retry_count_check"
    CHECK ("retry_count" >= 0);

ALTER TABLE "metric_collection_runs"
    ADD CONSTRAINT "metric_collection_runs_attempt_check"
    CHECK ("attempt" > 0),
    ADD CONSTRAINT "metric_collection_runs_date_range_check"
    CHECK ("start_date" <= "end_date"),
    ADD CONSTRAINT "metric_collection_runs_snapshot_count_check"
    CHECK ("snapshot_count" >= 0);

ALTER TABLE "analytics_metric_snapshots"
    ADD CONSTRAINT "analytics_metric_snapshots_daily_period_check"
    CHECK ("period_start" = "period_end"),
    ADD CONSTRAINT "analytics_metric_snapshots_value_check"
    CHECK ("value" IS NULL OR "value" >= 0),
    ADD CONSTRAINT "analytics_metric_snapshots_availability_check"
    CHECK (
        ("availability" = 'AVAILABLE' AND "value" IS NOT NULL AND "unavailable_reason" IS NULL)
        OR
        ("availability" = 'UNAVAILABLE' AND "value" IS NULL AND "unavailable_reason" IS NOT NULL)
    );

CREATE FUNCTION prevent_analytics_metric_snapshot_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Analytics metric snapshots are immutable';
END;
$$;

CREATE TRIGGER analytics_metric_snapshots_immutable
    BEFORE UPDATE ON "analytics_metric_snapshots"
    FOR EACH ROW EXECUTE FUNCTION prevent_analytics_metric_snapshot_update();

INSERT INTO "analytics_metric_definitions" (
    "id", "platform", "key", "label", "description", "account_eligibility",
    "required_scopes", "granularities", "source_api", "documentation_url",
    "availability_notes", "verified_at"
) VALUES
    ('14000000-0000-4000-8000-000000000001', 'YOUTUBE', 'views', 'Views',
     'Number of views for the requested channel or video report.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL', 'VIDEO']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#views',
     'Daily reports can end before the requested end date while YouTube finishes reporting; omitted days are unavailable, not zero.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000002', 'YOUTUBE', 'likes', 'Likes',
     'Number of times users liked a video.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL', 'VIDEO']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#likes',
     'Available for channel video reports; recent dates may be delayed and revisions are retained as new snapshots.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000003', 'YOUTUBE', 'comments', 'Comments',
     'Number of times users commented on a video.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL', 'VIDEO']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#comments',
     'Available for channel video reports; recent dates may be delayed and revisions are retained as new snapshots.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000004', 'YOUTUBE', 'shares', 'Shares',
     'Number of times users shared a video through the Share button.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL', 'VIDEO']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#shares',
     'Available for channel video reports; recent dates may be delayed and revisions are retained as new snapshots.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000005', 'YOUTUBE', 'estimatedMinutesWatched',
     'Estimated minutes watched', 'Estimated number of minutes users watched videos.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL', 'VIDEO']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#estimatedMinutesWatched',
     'Values are estimates; report coverage is limited to dates for which all requested metrics are available.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000006', 'YOUTUBE', 'subscribersGained',
     'Subscribers gained', 'Number of times users subscribed to the channel.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#subscribersGained',
     'Channel totals include subscriptions from channel surfaces. Video-filtered reports count only subscriptions from that video watch page.',
     DATE '2026-11-10'),
    ('14000000-0000-4000-8000-000000000007', 'YOUTUBE', 'subscribersLost',
     'Subscribers lost', 'Number of times users unsubscribed from the channel.',
     'Authorized owner of the YouTube channel identified by the account.',
     ARRAY['https://www.googleapis.com/auth/youtube.readonly'],
     ARRAY['CHANNEL']::"AnalyticsGranularity"[],
     'youtubeanalytics.googleapis.com/v2/reports',
     'https://developers.google.com/youtube/analytics/metrics#subscribersLost',
     'Channel totals include unsubscribes from channel surfaces. Video-filtered reports count only unsubscribes from that video watch page.',
     DATE '2026-11-10');
