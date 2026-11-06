CREATE TYPE "IdeaStatus" AS ENUM ('DRAFT', 'BACKLOG', 'APPROVED', 'REJECTED', 'SCHEDULED');
CREATE TYPE "IdeaOrigin" AS ENUM ('USER', 'AI');

CREATE TABLE "ideas" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "channel_id" UUID,
  "series_id" UUID,
  "status" "IdeaStatus" NOT NULL DEFAULT 'DRAFT',
  "origin" "IdeaOrigin" NOT NULL,
  "title" TEXT NOT NULL,
  "normalized_title" TEXT NOT NULL,
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
  "scheduled_at" TIMESTAMPTZ(6),
  "approved_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ideas_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "idea_duplicates" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "idea_id" UUID NOT NULL,
  "matched_idea_id" UUID,
  "reason" TEXT NOT NULL,
  "score" DECIMAL(6,5) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idea_duplicates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ideas_workspace_id_id_key" ON "ideas"("workspace_id", "id");
CREATE INDEX "ideas_workspace_id_normalized_title_idx" ON "ideas"("workspace_id", "normalized_title");
CREATE INDEX "ideas_workspace_id_status_scheduled_at_idx" ON "ideas"("workspace_id", "status", "scheduled_at");
CREATE INDEX "ideas_workspace_id_channel_id_series_id_approved_at_idx" ON "ideas"("workspace_id", "channel_id", "series_id", "approved_at");
CREATE UNIQUE INDEX "idea_duplicates_workspace_id_id_key" ON "idea_duplicates"("workspace_id", "id");
CREATE INDEX "idea_duplicates_workspace_id_idea_id_idx" ON "idea_duplicates"("workspace_id", "idea_id");
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idea_duplicates" ADD CONSTRAINT "idea_duplicates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idea_duplicates" ADD CONSTRAINT "idea_duplicates_workspace_id_idea_id_fkey" FOREIGN KEY ("workspace_id", "idea_id") REFERENCES "ideas"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
