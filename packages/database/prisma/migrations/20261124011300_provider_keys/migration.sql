CREATE TABLE "provider_keys" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL DEFAULT '1.0',
  "provider_id" TEXT NOT NULL CHECK ("provider_id" IN ('gemini', 'xai')),
  "ciphertext" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "key_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "provider_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "provider_keys_workspace_id_provider_id_key" ON "provider_keys"("workspace_id", "provider_id");
