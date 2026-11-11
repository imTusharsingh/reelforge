-- Preserve planning history while hiding archived, unapproved ideas from the active board.
ALTER TABLE "ideas" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
CREATE INDEX "ideas_workspace_id_archived_at_idx" ON "ideas"("workspace_id", "archived_at");
