-- M17 notifications and reporting (additive only).

-- CreateEnum
CREATE TYPE "NotificationFanoutStatus" AS ENUM ('PENDING', 'DONE');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'RETRY_WAIT', 'FAILED', 'SKIPPED_NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "ChannelReportPeriod" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "ChannelReportTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recipient_member_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID,
    "event_type" TEXT NOT NULL,
    "source_module" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "correlation_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "link" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "fanout_status" "NotificationFanoutStatus" NOT NULL DEFAULT 'PENDING',
    "fanned_out_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recipient_member_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "channel_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "recipient_member_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "dedupe_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "provider_message_id" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_intake_cursors" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "after_at" TIMESTAMPTZ(6),
    "after_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_intake_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "period_type" "ChannelReportPeriod" NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "local_start_date" TEXT NOT NULL,
    "local_end_date" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "trigger" "ChannelReportTrigger" NOT NULL,
    "generated_by_user_id" UUID,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "missing_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_workspace_id_recipient_member_id_e_key" ON "notification_preferences"("workspace_id", "recipient_member_id", "event_type");

-- CreateIndex
CREATE INDEX "notification_events_fanout_status_created_at_idx" ON "notification_events"("fanout_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_workspace_id_id_key" ON "notification_events"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_workspace_id_source_key_key" ON "notification_events"("workspace_id", "source_key");

-- CreateIndex
CREATE INDEX "notifications_workspace_id_recipient_member_id_read_at_crea_idx" ON "notifications"("workspace_id", "recipient_member_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_workspace_id_id_key" ON "notifications"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_workspace_id_recipient_member_id_dedupe_key_key" ON "notifications"("workspace_id", "recipient_member_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_workspace_id_recipient_member_id_cr_idx" ON "notification_deliveries"("workspace_id", "recipient_member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_workspace_id_id_key" ON "notification_deliveries"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_workspace_id_recipient_member_id_ch_key" ON "notification_deliveries"("workspace_id", "recipient_member_id", "channel", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_intake_cursors_source_key" ON "notification_intake_cursors"("source");

-- CreateIndex
CREATE INDEX "channel_reports_workspace_id_channel_id_period_type_period__idx" ON "channel_reports"("workspace_id", "channel_id", "period_type", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reports_workspace_id_id_key" ON "channel_reports"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reports_channel_id_period_type_period_start_key" ON "channel_reports"("channel_id", "period_type", "period_start");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_recipient_member_id_fkey" FOREIGN KEY ("recipient_member_id") REFERENCES "workspace_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_member_id_fkey" FOREIGN KEY ("recipient_member_id") REFERENCES "workspace_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "notification_events"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipient_member_id_fkey" FOREIGN KEY ("recipient_member_id") REFERENCES "workspace_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_event_id_fkey" FOREIGN KEY ("workspace_id", "event_id") REFERENCES "notification_events"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reports" ADD CONSTRAINT "channel_reports_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
