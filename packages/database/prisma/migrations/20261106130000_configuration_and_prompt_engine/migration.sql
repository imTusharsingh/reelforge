-- M05 configuration, prompt template, and immutable snapshot persistence.
-- This migration is additive. It does not rewrite existing channel, genre,
-- series, or character data.

-- CreateEnum
CREATE TYPE "PromptTemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "active_config_snapshot_id" UUID;

-- CreateTable
CREATE TABLE "workspace_config_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "locked_fields" JSONB NOT NULL,
    "fingerprint_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_config_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_config_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "workspace_config_snapshot_id" UUID,
    "channel_id" UUID,
    "genre_id" UUID,
    "series_id" UUID,
    "config" JSONB NOT NULL,
    "fingerprint_sha256" TEXT NOT NULL,
    "resolution_sha256" TEXT NOT NULL,
    "layers" JSONB NOT NULL,
    "locked_fields" JSONB NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_config_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_template_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PromptTemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "body" JSONB NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_bundle_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config_snapshot_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "bundle" JSONB NOT NULL,
    "fingerprint_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_bundle_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_config_snapshots_workspace_id_created_at_idx" ON "workspace_config_snapshots"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_config_snapshots_workspace_id_id_key" ON "workspace_config_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_config_snapshots_workspace_id_version_key" ON "workspace_config_snapshots"("workspace_id", "version");

-- CreateIndex
CREATE INDEX "generation_config_snapshots_workspace_id_created_at_idx" ON "generation_config_snapshots"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "generation_config_snapshots_workspace_id_series_id_idx" ON "generation_config_snapshots"("workspace_id", "series_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_config_snapshots_workspace_id_id_key" ON "generation_config_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_config_snapshots_workspace_id_version_key" ON "generation_config_snapshots"("workspace_id", "version");

-- CreateIndex
CREATE INDEX "prompt_templates_workspace_id_idx" ON "prompt_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_workspace_id_id_key" ON "prompt_templates"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_workspace_id_key_key" ON "prompt_templates"("workspace_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_workspace_id_active_version_id_key" ON "prompt_templates"("workspace_id", "active_version_id");

-- CreateIndex
CREATE INDEX "prompt_template_versions_workspace_id_template_id_created_a_idx" ON "prompt_template_versions"("workspace_id", "template_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_template_versions_workspace_id_id_key" ON "prompt_template_versions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_template_versions_workspace_id_template_id_version_key" ON "prompt_template_versions"("workspace_id", "template_id", "version");

-- CreateIndex
CREATE INDEX "prompt_bundle_snapshots_workspace_id_config_snapshot_id_idx" ON "prompt_bundle_snapshots"("workspace_id", "config_snapshot_id");

-- CreateIndex
CREATE INDEX "prompt_bundle_snapshots_workspace_id_template_id_idx" ON "prompt_bundle_snapshots"("workspace_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_bundle_snapshots_workspace_id_id_key" ON "prompt_bundle_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_bundle_snapshots_workspace_id_version_key" ON "prompt_bundle_snapshots"("workspace_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_active_config_snapshot_id_key" ON "workspaces"("active_config_snapshot_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_active_config_snapshot_id_fkey" FOREIGN KEY ("active_config_snapshot_id") REFERENCES "workspace_config_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_config_snapshots" ADD CONSTRAINT "workspace_config_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_config_snapshots" ADD CONSTRAINT "generation_config_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_config_snapshots" ADD CONSTRAINT "generation_config_snapshots_workspace_id_workspace_config__fkey" FOREIGN KEY ("workspace_id", "workspace_config_snapshot_id") REFERENCES "workspace_config_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_workspace_id_active_version_id_fkey" FOREIGN KEY ("workspace_id", "active_version_id") REFERENCES "prompt_template_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_template_versions" ADD CONSTRAINT "prompt_template_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_template_versions" ADD CONSTRAINT "prompt_template_versions_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "prompt_templates"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_bundle_snapshots" ADD CONSTRAINT "prompt_bundle_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_bundle_snapshots" ADD CONSTRAINT "prompt_bundle_snapshots_workspace_id_config_snapshot_id_fkey" FOREIGN KEY ("workspace_id", "config_snapshot_id") REFERENCES "generation_config_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_bundle_snapshots" ADD CONSTRAINT "prompt_bundle_snapshots_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "prompt_templates"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_bundle_snapshots" ADD CONSTRAINT "prompt_bundle_snapshots_workspace_id_template_version_id_fkey" FOREIGN KEY ("workspace_id", "template_version_id") REFERENCES "prompt_template_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
