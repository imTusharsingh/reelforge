CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "display_name" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workspaces" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workspace_memberships" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "WorkspaceRole" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channels" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_series" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "content_series_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assets" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "object_key" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "videos" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "series_id" UUID,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "posts" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "video_id" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "remote_post_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_runs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "correlation_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "event_version" INTEGER NOT NULL,
  "correlation_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(6),
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "workspace_memberships_workspace_id_user_id_key" ON "workspace_memberships"("workspace_id", "user_id");
CREATE INDEX "workspace_memberships_user_id_idx" ON "workspace_memberships"("user_id");
CREATE UNIQUE INDEX "channels_workspace_id_id_key" ON "channels"("workspace_id", "id");
CREATE INDEX "channels_workspace_id_idx" ON "channels"("workspace_id");
CREATE UNIQUE INDEX "content_series_workspace_id_id_key" ON "content_series"("workspace_id", "id");
CREATE INDEX "content_series_workspace_id_channel_id_idx" ON "content_series"("workspace_id", "channel_id");
CREATE UNIQUE INDEX "assets_workspace_id_id_key" ON "assets"("workspace_id", "id");
CREATE UNIQUE INDEX "assets_workspace_id_object_key_key" ON "assets"("workspace_id", "object_key");
CREATE INDEX "assets_workspace_id_idx" ON "assets"("workspace_id");
CREATE UNIQUE INDEX "videos_workspace_id_id_key" ON "videos"("workspace_id", "id");
CREATE INDEX "videos_workspace_id_channel_id_created_at_idx" ON "videos"("workspace_id", "channel_id", "created_at");
CREATE UNIQUE INDEX "posts_workspace_id_id_key" ON "posts"("workspace_id", "id");
CREATE INDEX "posts_workspace_id_channel_id_created_at_idx" ON "posts"("workspace_id", "channel_id", "created_at");
CREATE UNIQUE INDEX "workflow_runs_workspace_id_idempotency_key_key" ON "workflow_runs"("workspace_id", "idempotency_key");
CREATE UNIQUE INDEX "workflow_runs_workspace_id_id_key" ON "workflow_runs"("workspace_id", "id");
CREATE INDEX "workflow_runs_workspace_id_state_created_at_idx" ON "workflow_runs"("workspace_id", "state", "created_at");
CREATE UNIQUE INDEX "outbox_events_workspace_id_idempotency_key_key" ON "outbox_events"("workspace_id", "idempotency_key");
CREATE INDEX "outbox_events_workspace_id_published_at_occurred_at_idx" ON "outbox_events"("workspace_id", "published_at", "occurred_at");

ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_series" ADD CONSTRAINT "content_series_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "videos" ADD CONSTRAINT "videos_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "videos" ADD CONSTRAINT "videos_workspace_id_series_id_fkey" FOREIGN KEY ("workspace_id", "series_id") REFERENCES "content_series"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_video_id_fkey" FOREIGN KEY ("workspace_id", "video_id") REFERENCES "videos"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
