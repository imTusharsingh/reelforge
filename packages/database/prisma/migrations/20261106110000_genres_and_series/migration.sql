CREATE TABLE "genre_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "key" TEXT NOT NULL, "name" TEXT NOT NULL,
  "audience" TEXT NOT NULL, "tone" TEXT NOT NULL, "topics_allowed" JSONB NOT NULL,
  "topics_blocked" JSONB NOT NULL, "language" TEXT NOT NULL, "structure" JSONB NOT NULL,
  "duration_preference" JSONB NOT NULL, "safety_profile" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "genre_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "genre_templates_key_key" ON "genre_templates"("key");
CREATE TABLE "genres" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspace_id" UUID NOT NULL,
  "template_id" UUID, "name" TEXT NOT NULL, "audience" TEXT NOT NULL, "tone" TEXT NOT NULL,
  "topics_allowed" JSONB NOT NULL, "topics_blocked" JSONB NOT NULL, "language" TEXT NOT NULL,
  "structure" JSONB NOT NULL, "duration_preference" JSONB NOT NULL, "safety_profile" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "genres_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "genres_workspace_id_id_key" ON "genres"("workspace_id", "id");
CREATE INDEX "genres_workspace_id_created_at_idx" ON "genres"("workspace_id", "created_at");
ALTER TABLE "genres" ADD CONSTRAINT "genres_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "genres" ADD CONSTRAINT "genres_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "genre_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "content_series" ADD COLUMN "genre_id" UUID, ADD COLUMN "format" TEXT, ADD COLUMN "frequency" TEXT, ADD COLUMN "character_group_refs" JSONB, ADD COLUMN "prompt_refs" JSONB;
INSERT INTO "genre_templates" ("key","name","audience","tone","topics_allowed","topics_blocked","language","structure","duration_preference","safety_profile") VALUES
('educational-explainer','Educational Explainer','General audience','Clear and curious','["science","history","how-to"]','["medical advice","political persuasion"]','en','{"opening":"hook","body":"explain","closing":"takeaway"}','{"minSeconds":30,"maxSeconds":60}','{"level":"standard","requiresHumanReview":true}'),
('storytime','Storytime','General audience','Warm and playful','["fiction","folklore","life lessons"]','["graphic violence","hate"]','en','{"opening":"setup","body":"rising-action","closing":"resolution"}','{"minSeconds":30,"maxSeconds":90}','{"level":"standard","requiresHumanReview":true}');
ALTER TABLE "content_series" ALTER COLUMN "genre_id" SET NOT NULL, ALTER COLUMN "format" SET NOT NULL, ALTER COLUMN "frequency" SET NOT NULL, ALTER COLUMN "character_group_refs" SET NOT NULL, ALTER COLUMN "prompt_refs" SET NOT NULL;
ALTER TABLE "content_series" ADD CONSTRAINT "content_series_workspace_id_genre_id_fkey" FOREIGN KEY ("workspace_id", "genre_id") REFERENCES "genres"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "content_series_workspace_id_genre_id_idx" ON "content_series"("workspace_id", "genre_id");
