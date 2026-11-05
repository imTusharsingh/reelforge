CREATE TYPE "ChannelStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

ALTER TABLE "channels"
  ADD COLUMN "handle" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "niche" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "audience" TEXT,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "goals" JSONB,
  ADD COLUMN "schedule" JSONB,
  ADD COLUMN "automation_defaults" JSONB,
  ADD COLUMN "approval_policy" JSONB,
  ADD COLUMN "publishing_destinations" JSONB,
  ADD COLUMN "status" "ChannelStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "active_snapshot_id" UUID;

CREATE TABLE "channel_config_snapshots" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "channel_config_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_config_snapshots_workspace_id_id_key" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "channel_config_snapshots_workspace_id_channel_id_version_key" UNIQUE ("workspace_id", "channel_id", "version"),
  CONSTRAINT "channel_config_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels" ("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "channel_config_snapshots_workspace_id_channel_id_created_at_idx" ON "channel_config_snapshots" ("workspace_id", "channel_id", "created_at");
ALTER TABLE "channels" ADD CONSTRAINT "channels_active_snapshot_fkey" FOREIGN KEY ("workspace_id", "active_snapshot_id") REFERENCES "channel_config_snapshots" ("workspace_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "channels_workspace_id_active_snapshot_id_key" ON "channels" ("workspace_id", "active_snapshot_id");
