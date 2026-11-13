ALTER TABLE "scheduled_posts" ADD COLUMN "client_request_id" UUID,
ADD COLUMN "client_request_hash" TEXT;
CREATE UNIQUE INDEX "scheduled_posts_workspace_id_client_request_id_key"
ON "scheduled_posts"("workspace_id", "client_request_id");
