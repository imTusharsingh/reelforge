-- CreateEnum
CREATE TYPE "AssetOwnership" AS ENUM ('USER_UPLOADED', 'STARTER_LIBRARY', 'SYSTEM_GENERATED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CharacterStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CharacterVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED');


-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "byte_size" INTEGER,
ADD COLUMN     "checksum_sha256" TEXT,
ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "filename" TEXT,
ADD COLUMN     "license_terms" TEXT,
ADD COLUMN     "license_type" TEXT,
ADD COLUMN     "ownership" "AssetOwnership" NOT NULL DEFAULT 'USER_UPLOADED',
ADD COLUMN     "rights_attested_at" TIMESTAMPTZ(6),
ADD COLUMN     "rights_holder" TEXT,
ADD COLUMN     "root_asset_id" UUID,
ADD COLUMN     "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "supersedes_asset_id" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- Existing assets predate asset versioning. Each legacy asset becomes the root
-- of its own version chain. They remain PENDING and cannot be referenced by a
-- generation job until real bytes and rights metadata are recorded.
UPDATE "assets" SET "root_asset_id" = "id" WHERE "root_asset_id" IS NULL;
ALTER TABLE "assets" ALTER COLUMN "root_asset_id" SET NOT NULL;


-- CreateTable
CREATE TABLE "asset_usage_references" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "asset_version" INTEGER NOT NULL,
    "used_by_type" TEXT NOT NULL,
    "used_by_id" UUID NOT NULL,
    "context" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_usage_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "personality" JSONB NOT NULL,
    "voice_preference" JSONB NOT NULL,
    "visual_invariants" JSONB NOT NULL,
    "variation_rules" JSONB NOT NULL,
    "starter_asset_key" TEXT,
    "rights_holder" TEXT NOT NULL,
    "license_type" TEXT NOT NULL,
    "license_terms" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "personality" JSONB NOT NULL,
    "voice_preference" JSONB NOT NULL,
    "visual_invariants" JSONB NOT NULL,
    "variation_rules" JSONB NOT NULL,
    "reference_assets" JSONB NOT NULL DEFAULT '[]',
    "status" "CharacterStatus" NOT NULL DEFAULT 'DRAFT',
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CharacterVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "profile" JSONB NOT NULL,
    "reference_assets" JSONB NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_groups" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "character_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_group_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "character_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_group_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "channel_id" UUID,
    "series_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_group_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_usage_references_workspace_id_used_by_type_used_by_id_idx" ON "asset_usage_references"("workspace_id", "used_by_type", "used_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_usage_references_workspace_id_asset_id_asset_version__key" ON "asset_usage_references"("workspace_id", "asset_id", "asset_version", "used_by_type", "used_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_templates_key_key" ON "character_templates"("key");

-- CreateIndex
CREATE INDEX "characters_workspace_id_idx" ON "characters"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "characters_workspace_id_id_key" ON "characters"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "characters_workspace_id_active_version_id_key" ON "characters"("workspace_id", "active_version_id");

-- CreateIndex
CREATE INDEX "character_versions_workspace_id_character_id_created_at_idx" ON "character_versions"("workspace_id", "character_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "character_versions_workspace_id_id_key" ON "character_versions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "character_versions_workspace_id_character_id_id_key" ON "character_versions"("workspace_id", "character_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "character_versions_workspace_id_character_id_version_key" ON "character_versions"("workspace_id", "character_id", "version");

-- CreateIndex
CREATE INDEX "character_groups_workspace_id_idx" ON "character_groups"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_groups_workspace_id_id_key" ON "character_groups"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "character_group_members_workspace_id_character_version_id_idx" ON "character_group_members"("workspace_id", "character_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_group_members_workspace_id_group_id_character_id_key" ON "character_group_members"("workspace_id", "group_id", "character_id");

-- CreateIndex
CREATE INDEX "character_group_assignments_workspace_id_channel_id_idx" ON "character_group_assignments"("workspace_id", "channel_id");

-- CreateIndex
CREATE INDEX "character_group_assignments_workspace_id_series_id_idx" ON "character_group_assignments"("workspace_id", "series_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_group_assignments_workspace_id_group_id_channel_i_key" ON "character_group_assignments"("workspace_id", "group_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_group_assignments_workspace_id_group_id_series_id_key" ON "character_group_assignments"("workspace_id", "group_id", "series_id");

-- CreateIndex
CREATE INDEX "assets_workspace_id_root_asset_id_idx" ON "assets"("workspace_id", "root_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_workspace_id_root_asset_id_version_key" ON "assets"("workspace_id", "root_asset_id", "version");


-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_supersedes_asset_id_fkey" FOREIGN KEY ("workspace_id", "supersedes_asset_id") REFERENCES "assets"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usage_references" ADD CONSTRAINT "asset_usage_references_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usage_references" ADD CONSTRAINT "asset_usage_references_workspace_id_asset_id_fkey" FOREIGN KEY ("workspace_id", "asset_id") REFERENCES "assets"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "character_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_workspace_id_active_version_id_fkey" FOREIGN KEY ("workspace_id", "active_version_id") REFERENCES "character_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_versions" ADD CONSTRAINT "character_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_versions" ADD CONSTRAINT "character_versions_workspace_id_character_id_fkey" FOREIGN KEY ("workspace_id", "character_id") REFERENCES "characters"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_groups" ADD CONSTRAINT "character_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_workspace_id_group_id_fkey" FOREIGN KEY ("workspace_id", "group_id") REFERENCES "character_groups"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_workspace_id_character_id_fkey" FOREIGN KEY ("workspace_id", "character_id") REFERENCES "characters"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_workspace_id_character_id_characte_fkey" FOREIGN KEY ("workspace_id", "character_id", "character_version_id") REFERENCES "character_versions"("workspace_id", "character_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_assignments" ADD CONSTRAINT "character_group_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_assignments" ADD CONSTRAINT "character_group_assignments_workspace_id_group_id_fkey" FOREIGN KEY ("workspace_id", "group_id") REFERENCES "character_groups"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_assignments" ADD CONSTRAINT "character_group_assignments_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_group_assignments" ADD CONSTRAINT "character_group_assignments_workspace_id_series_id_fkey" FOREIGN KEY ("workspace_id", "series_id") REFERENCES "content_series"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "character_group_assignments" ADD CONSTRAINT "character_group_assignments_exactly_one_target" CHECK ((("channel_id" IS NOT NULL)::int + ("series_id" IS NOT NULL)::int) = 1);

-- Seed the built-in starter character catalog. Artwork bytes live in the API
-- module and are imported into a workspace on demand; these rows carry the
-- documented ownership and CC0-1.0 rights metadata.
INSERT INTO "character_templates" ("id","key","name","description","personality","voice_preference","visual_invariants","variation_rules","starter_asset_key","rights_holder","license_type","license_terms") VALUES
(gen_random_uuid(),'starter-nova','Nova','A curious science explainer who turns complex ideas into friendly, visual stories.','{"traits":["curious","friendly","precise"],"energy":"warm","humor":"light"}','{"style":"conversational","pace":"measured","accent":"neutral"}','{"palette":["#7c5cff","#ffd166"],"signature":"glowing ring badge","silhouette":"round avatar","background":"deep navy"}','{"allowed":["pose","expression","outfit color"],"forbidden":["face shape","signature badge removal","palette swap"]}','starter-nova','ReelForge project authors','CC0-1.0','Dedicated to the public domain under CC0 1.0 Universal.'),
(gen_random_uuid(),'starter-atlas','Atlas','An adventurous storyteller who maps folktales and faraway places into serialized journeys.','{"traits":["bold","warm","reflective"],"energy":"adventurous","humor":"dry"}','{"style":"storyteller","pace":"varied","accent":"neutral"}','{"palette":["#40c4b4","#24788c"],"signature":"checkerboard compass cloak","silhouette":"angular avatar","background":"charcoal"}','{"allowed":["camera angle","weather","props"],"forbidden":["palette swap","compass removal","silhouette change"]}','starter-atlas','ReelForge project authors','CC0-1.0','Dedicated to the public domain under CC0 1.0 Universal.')
ON CONFLICT ("key") DO NOTHING;
