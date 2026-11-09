-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('YOUTUBE', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED', 'REVOCATION_PENDING', 'REVOCATION_FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SocialAccountHealth" AS ENUM ('HEALTHY', 'AUTH_REQUIRED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "SocialPermissionStatus" AS ENUM ('GRANTED', 'NOT_GRANTED');

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "remote_account_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "username" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "health" "SocialAccountHealth" NOT NULL DEFAULT 'UNAVAILABLE',
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_health_check_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_account_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "access_token_ciphertext" TEXT NOT NULL,
    "access_token_nonce" TEXT NOT NULL,
    "access_token_tag" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT,
    "refresh_token_nonce" TEXT,
    "refresh_token_tag" TEXT,
    "encryption_key_version" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "social_account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_account_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "status" "SocialPermissionStatus" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_account_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_account_capabilities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "details" JSONB,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_account_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_oauth_states" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "expected_remote_account_id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "code_verifier_ciphertext" TEXT NOT NULL,
    "code_verifier_nonce" TEXT NOT NULL,
    "code_verifier_tag" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_accounts_workspace_id_channel_id_platform_status_idx" ON "social_accounts"("workspace_id", "channel_id", "platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_workspace_id_id_key" ON "social_accounts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_workspace_id_channel_id_platform_remote_acc_key" ON "social_accounts"("workspace_id", "channel_id", "platform", "remote_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_account_tokens_social_account_id_key" ON "social_account_tokens"("social_account_id");

-- CreateIndex
CREATE INDEX "social_account_tokens_workspace_id_access_token_expires_at_idx" ON "social_account_tokens"("workspace_id", "access_token_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_account_tokens_workspace_id_social_account_id_key" ON "social_account_tokens"("workspace_id", "social_account_id");

-- CreateIndex
CREATE INDEX "social_account_permissions_workspace_id_social_account_id_idx" ON "social_account_permissions"("workspace_id", "social_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_account_permissions_social_account_id_permission_key" ON "social_account_permissions"("social_account_id", "permission");

-- CreateIndex
CREATE INDEX "social_account_capabilities_workspace_id_social_account_id_idx" ON "social_account_capabilities"("workspace_id", "social_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_account_capabilities_social_account_id_capability_key" ON "social_account_capabilities"("social_account_id", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "social_oauth_states_state_hash_key" ON "social_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "social_oauth_states_workspace_id_user_id_expires_at_idx" ON "social_oauth_states"("workspace_id", "user_id", "expires_at");

-- CreateIndex
CREATE INDEX "social_oauth_states_expires_at_consumed_at_idx" ON "social_oauth_states"("expires_at", "consumed_at");

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_account_tokens" ADD CONSTRAINT "social_account_tokens_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_account_permissions" ADD CONSTRAINT "social_account_permissions_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_account_capabilities" ADD CONSTRAINT "social_account_capabilities_workspace_id_social_account_id_fkey" FOREIGN KEY ("workspace_id", "social_account_id") REFERENCES "social_accounts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_states" ADD CONSTRAINT "social_oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_states" ADD CONSTRAINT "social_oauth_states_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_oauth_states" ADD CONSTRAINT "social_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
