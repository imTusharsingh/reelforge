CREATE TABLE "idea_approval_snapshots" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "idea_id" UUID NOT NULL,
  "channel_id" UUID,
  "series_id" UUID,
  "topic" TEXT NOT NULL,
  "hook" TEXT NOT NULL,
  "angle" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "references" JSONB NOT NULL,
  "source_notes" TEXT,
  "expected_format" TEXT NOT NULL,
  "model_version" TEXT,
  "prompt_version" TEXT,
  "cost" DECIMAL(18,8),
  "cost_currency" TEXT,
  "checksum_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idea_approval_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "idea_approval_snapshots_workspace_id_id_key" ON "idea_approval_snapshots"("workspace_id", "id");
CREATE UNIQUE INDEX "idea_approval_snapshots_workspace_id_idea_id_key" ON "idea_approval_snapshots"("workspace_id", "idea_id");
CREATE INDEX "idea_approval_snapshots_workspace_id_channel_id_series_id_idx" ON "idea_approval_snapshots"("workspace_id", "channel_id", "series_id");
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_series_id_fkey" FOREIGN KEY ("workspace_id", "series_id") REFERENCES "content_series"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idea_duplicates" ADD CONSTRAINT "idea_duplicates_workspace_id_matched_idea_id_fkey" FOREIGN KEY ("workspace_id", "matched_idea_id") REFERENCES "ideas"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idea_approval_snapshots" ADD CONSTRAINT "idea_approval_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idea_approval_snapshots" ADD CONSTRAINT "idea_approval_snapshots_workspace_id_idea_id_fkey" FOREIGN KEY ("workspace_id", "idea_id") REFERENCES "ideas"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idea_approval_snapshots" ADD CONSTRAINT "idea_approval_snapshots_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idea_approval_snapshots" ADD CONSTRAINT "idea_approval_snapshots_workspace_id_series_id_fkey" FOREIGN KEY ("workspace_id", "series_id") REFERENCES "content_series"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
