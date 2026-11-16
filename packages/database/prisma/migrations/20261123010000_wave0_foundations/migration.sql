-- CreateEnum
CREATE TYPE "VideoRunState" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'PAUSED_BUDGET', 'NEEDS_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VideoRunStepState" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'WAITING_APPROVAL', 'PAUSED', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "ReferenceKind" AS ENUM ('CHARACTER', 'STYLE', 'SCENERY', 'PROP');

-- CreateEnum
CREATE TYPE "ReferenceSource" AS ENUM ('SYSTEM', 'PRESET', 'UPLOADED', 'USER_GENERATED');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "narrator_voice" JSONB;

-- CreateTable
CREATE TABLE "workspace_foundation_defaults" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_foundation_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "format_templates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "structure" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "format_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_briefs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" TEXT NOT NULL DEFAULT '1.0',
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "channel_brief_id" UUID NOT NULL,
    "state" "VideoRunState" NOT NULL DEFAULT 'CREATED',
    "requested_autonomy" "AutonomyLevel" NOT NULL DEFAULT 'L2',
    "effective_autonomy" "AutonomyLevel" NOT NULL DEFAULT 'L2',
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "input_snapshot" JSONB NOT NULL,
    "published_shorts_at_start" INTEGER NOT NULL DEFAULT 0,
    "critic_agreement_score" DOUBLE PRECISION,
    "pause_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_run_steps" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "state" "VideoRunStepState" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "provider_id" TEXT,
    "provider_job_id" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_specs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schema_version" TEXT NOT NULL DEFAULT '1.0',
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shot_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_capabilities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schema_version" TEXT NOT NULL DEFAULT '1.0',
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_envelopes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "target_minor" INTEGER NOT NULL DEFAULT 600,
    "hard_cap_minor" INTEGER NOT NULL DEFAULT 800,
    "reserved_minor" INTEGER NOT NULL DEFAULT 0,
    "spent_minor" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_assets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "reference_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" "ReferenceKind" NOT NULL,
    "source" "ReferenceSource" NOT NULL,
    "asset_id" UUID,
    "asset_version" INTEGER,
    "character_version_id" UUID,
    "checksum_sha256" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL DEFAULT '1.0',
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_reference_defaults" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "schema_version" TEXT NOT NULL DEFAULT '1.0',
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_reference_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_foundation_defaults_workspace_id_key" ON "workspace_foundation_defaults"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_foundation_defaults_workspace_id_id_key" ON "workspace_foundation_defaults"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "format_templates_workspace_id_key_version_key" ON "format_templates"("workspace_id", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "format_templates_workspace_id_id_key" ON "format_templates"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_briefs_workspace_id_channel_id_version_key" ON "channel_briefs"("workspace_id", "channel_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "channel_briefs_workspace_id_id_key" ON "channel_briefs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "video_runs_workspace_id_channel_id_state_idx" ON "video_runs"("workspace_id", "channel_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "video_runs_workspace_id_idempotency_key_key" ON "video_runs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "video_runs_workspace_id_id_key" ON "video_runs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "video_run_steps_workspace_id_run_id_key_attempt_key" ON "video_run_steps"("workspace_id", "run_id", "key", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "video_run_steps_workspace_id_idempotency_key_key" ON "video_run_steps"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "video_run_steps_workspace_id_run_id_id_key" ON "video_run_steps"("workspace_id", "run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "video_run_steps_workspace_id_id_key" ON "video_run_steps"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shot_specs_workspace_id_run_id_ordinal_version_key" ON "shot_specs"("workspace_id", "run_id", "ordinal", "version");

-- CreateIndex
CREATE UNIQUE INDEX "shot_specs_workspace_id_id_key" ON "shot_specs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_capabilities_workspace_id_provider_id_model_id_kin_key" ON "provider_capabilities"("workspace_id", "provider_id", "model_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "provider_capabilities_workspace_id_id_key" ON "provider_capabilities"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_workspace_id_run_id_sequence_key" ON "run_events"("workspace_id", "run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_workspace_id_id_key" ON "run_events"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_envelopes_workspace_id_run_id_key" ON "budget_envelopes"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_envelopes_workspace_id_id_key" ON "budget_envelopes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_assets_workspace_id_reference_id_version_key" ON "reference_assets"("workspace_id", "reference_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "reference_assets_workspace_id_id_key" ON "reference_assets"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reference_defaults_workspace_id_channel_id_key" ON "channel_reference_defaults"("workspace_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_reference_defaults_workspace_id_id_key" ON "channel_reference_defaults"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_workspace_id_id_version_key" ON "assets"("workspace_id", "id", "version");

-- AddForeignKey
ALTER TABLE "workspace_foundation_defaults" ADD CONSTRAINT "workspace_foundation_defaults_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "format_templates" ADD CONSTRAINT "format_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_briefs" ADD CONSTRAINT "channel_briefs_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_briefs" ADD CONSTRAINT "channel_briefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_runs" ADD CONSTRAINT "video_runs_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_runs" ADD CONSTRAINT "video_runs_workspace_id_channel_brief_id_fkey" FOREIGN KEY ("workspace_id", "channel_brief_id") REFERENCES "channel_briefs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_runs" ADD CONSTRAINT "video_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_run_steps" ADD CONSTRAINT "video_run_steps_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "video_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_run_steps" ADD CONSTRAINT "video_run_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_specs" ADD CONSTRAINT "shot_specs_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "video_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_specs" ADD CONSTRAINT "shot_specs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_capabilities" ADD CONSTRAINT "provider_capabilities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "video_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_workspace_id_run_id_step_id_fkey" FOREIGN KEY ("workspace_id", "run_id", "step_id") REFERENCES "video_run_steps"("workspace_id", "run_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_envelopes" ADD CONSTRAINT "budget_envelopes_workspace_id_run_id_fkey" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "video_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_envelopes" ADD CONSTRAINT "budget_envelopes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_assets" ADD CONSTRAINT "reference_assets_workspace_id_asset_id_asset_version_fkey" FOREIGN KEY ("workspace_id", "asset_id", "asset_version") REFERENCES "assets"("workspace_id", "id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_assets" ADD CONSTRAINT "reference_assets_workspace_id_character_version_id_fkey" FOREIGN KEY ("workspace_id", "character_version_id") REFERENCES "character_versions"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_assets" ADD CONSTRAINT "reference_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reference_defaults" ADD CONSTRAINT "channel_reference_defaults_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reference_defaults" ADD CONSTRAINT "channel_reference_defaults_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integer minor units; durable safety constraints complement runtime contracts.
ALTER TABLE budget_envelopes ADD CONSTRAINT budget_envelope_bounds CHECK
(currency = 'USD' AND target_minor >= 0 AND target_minor <= hard_cap_minor AND hard_cap_minor > 0
AND reserved_minor >= 0 AND spent_minor >= 0 AND reserved_minor + spent_minor <= hard_cap_minor);
ALTER TABLE video_runs ADD CONSTRAINT video_run_bounds CHECK
(revision >= 0 AND published_shorts_at_start >= 0 AND (critic_agreement_score IS NULL OR critic_agreement_score BETWEEN 0 AND 1));
ALTER TABLE video_run_steps ADD CONSTRAINT video_run_step_attempt CHECK (attempt > 0);
ALTER TABLE shot_specs ADD CONSTRAINT shot_spec_version CHECK (version > 0 AND ordinal >= 0);
ALTER TABLE reference_assets ADD CONSTRAINT reference_asset_version CHECK
(version > 0 AND (asset_id IS NULL) = (asset_version IS NULL) AND checksum_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE run_events ADD CONSTRAINT run_event_sequence CHECK (sequence > 0);

-- M04 references and event history are immutable; workspace cascading cleanup remains allowed.
CREATE FUNCTION reject_foundation_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Foundation version/event history is immutable';
END $$;
CREATE TRIGGER immutable_reference_asset BEFORE UPDATE OR DELETE ON reference_assets FOR EACH ROW EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_channel_brief BEFORE UPDATE OR DELETE ON channel_briefs FOR EACH ROW EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_shot_spec BEFORE UPDATE OR DELETE ON shot_specs FOR EACH ROW EXECUTE FUNCTION reject_foundation_rewrite();
CREATE TRIGGER immutable_run_event BEFORE UPDATE OR DELETE ON run_events FOR EACH ROW EXECUTE FUNCTION reject_foundation_rewrite();

-- Canonical JSON matches M05 jsonFingerprint (sorted object keys, no whitespace).
CREATE FUNCTION foundation_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || foundation_canonical_json(val), ',' ORDER BY key COLLATE "C"), '') || '}' INTO result FROM jsonb_each(value) AS entry(key,val);
 WHEN 'array' THEN SELECT '[' || coalesce(string_agg(foundation_canonical_json(val), ',' ORDER BY ord), '') || ']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(val,ord);
 ELSE result := value::text;
 END CASE;
 RETURN result;
END $$;

-- One transaction, per-workspace lock, no network and no provider registration.
-- Preserve existing user configuration/budgets. Repeated seed performs no updates.
CREATE FUNCTION seed_workspace_foundations(tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cfg uuid; tmpl uuid; ver uuid; bundle_id uuid; payload jsonb; fingerprint text; row_data jsonb; item jsonb; ws_cfg uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('wave0:' || tenant::text, 0));
 IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = tenant) THEN RAISE EXCEPTION 'Workspace missing'; END IF;
 IF EXISTS (SELECT 1 FROM workspace_foundation_defaults WHERE workspace_id = tenant) THEN RETURN; END IF;
 INSERT INTO provider_budgets (id,workspace_id,daily_limit,currency,updated_at)
 SELECT gen_random_uuid(),tenant,20,'USD',now() WHERE NOT EXISTS (SELECT 1 FROM provider_budgets WHERE workspace_id=tenant AND channel_id IS NULL);
 INSERT INTO usage_budgets (id,workspace_id,scope_key,currency,daily_limit_minor,monthly_limit_minor,timezone,updated_at)
 VALUES (gen_random_uuid(),tenant,'WORKSPACE','USD',2000,18000,'UTC',now()) ON CONFLICT (workspace_id,scope_key) DO NOTHING;
 cfg := gen_random_uuid();
 INSERT INTO generation_config_snapshots (id,workspace_id,version,config,fingerprint_sha256,resolution_sha256,layers,locked_fields)
 SELECT cfg,tenant,coalesce(max(version),0)+1,'{"schemaVersion":1,"identity":{"language":"en","audience":"General audience","tone":"Clear and friendly","niche":"general","format":"short","frequency":"daily"},"topics":{"allowed":["education","how-to"],"blocked":["medical advice","hate"]},"structure":{"opening":"hook","body":"explain","closing":"takeaway"},"duration":{"minSeconds":15,"maxSeconds":60},"safetyProfile":{"level":"standard","requiresHumanReview":true},"characters":[],"video":{"aspectRatio":"9:16","width":1080,"height":1920,"frameRate":24},"policies":{},"prompt":{"templateRefs":[]},"platformPolicy":{"defaultsVersion":"m05-platform-v1","allowUserOverrideOfProtectedSections":false},"safetyPolicy":{"requiresHumanReview":true,"minimumLevel":"standard","blockedTopics":["medical advice","hate","graphic violence"]},"rightsPolicy":{"requireDocumentedRights":true,"allowUnlicensedMusic":false,"allowedLicenseTypes":["CC0-1.0","CC-BY-4.0","USER_OWNED"]},"systemPolicy":{"bundleFormatVersion":"m05.1","protectedSections":["system","safety","rights"]}}'::jsonb,'fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e','40520a57db1cf2b2ed8e27512c1fa1ab97898015774af91b62e3c707fef99188','[]','["platformPolicy","rightsPolicy","safetyPolicy","systemPolicy"]' FROM generation_config_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.planner','planner v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.planner';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the planner agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'e39fa88cb762583d3331ef9c793c2bbcfc4ffb1723f10cf59e360bce64b2d023',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.planner","templateName":"planner v1","versionId":"VERSION_ID","version":1,"checksumSha256":"e39fa88cb762583d3331ef9c793c2bbcfc4ffb1723f10cf59e360bce64b2d023"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the planner agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the planner agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.researcher','researcher v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.researcher';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the researcher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'5e314121adc7010f6120532b25dcee2078e38c2005f0a07f6148b512e0a6754d',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.researcher","templateName":"researcher v1","versionId":"VERSION_ID","version":1,"checksumSha256":"5e314121adc7010f6120532b25dcee2078e38c2005f0a07f6148b512e0a6754d"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the researcher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the researcher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.scriptwriter','scriptwriter v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.scriptwriter';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the scriptwriter agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return ScriptDocument schemaVersion 1.0 with title, hook, dialogue, narration, cta, metadata {genre: \"Explainer\", targetDurationSeconds: 30, factual: false}, and scenes with id, startSeconds, durationSeconds, characterRefs (optional characters as []), dialogue, narration, visualDescription, camera, audioCues. Sum scene durations to target."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'105bf38d40e506de19e6c7f8ba618e10912f1dee295fcb7bee4ff5ee7f6cd8ae',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.scriptwriter","templateName":"scriptwriter v1","versionId":"VERSION_ID","version":1,"checksumSha256":"105bf38d40e506de19e6c7f8ba618e10912f1dee295fcb7bee4ff5ee7f6cd8ae"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the scriptwriter agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return ScriptDocument schemaVersion 1.0 with title, hook, dialogue, narration, cta, metadata {genre: \"Explainer\", targetDurationSeconds: 30, factual: false}, and scenes with id, startSeconds, durationSeconds, characterRefs (optional characters as []), dialogue, narration, visualDescription, camera, audioCues. Sum scene durations to target."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the scriptwriter agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn ScriptDocument schemaVersion 1.0 with title, hook, dialogue, narration, cta, metadata {genre: \"Explainer\", targetDurationSeconds: 30, factual: false}, and scenes with id, startSeconds, durationSeconds, characterRefs (optional characters as []), dialogue, narration, visualDescription, camera, audioCues. Sum scene durations to target.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.storyboard','storyboard v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.storyboard';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the storyboard agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'b23c32db4490d3d114f80b02cd6fa9212bd5787fc0cc00752264c4599ec94cce',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.storyboard","templateName":"storyboard v1","versionId":"VERSION_ID","version":1,"checksumSha256":"b23c32db4490d3d114f80b02cd6fa9212bd5787fc0cc00752264c4599ec94cce"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the storyboard agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the storyboard agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.director','director v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.director';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the director agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'1256e043bdf20d8bf4955e5efbc63032d533c3beaf95dbd465e5ce109450a7c6',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.director","templateName":"director v1","versionId":"VERSION_ID","version":1,"checksumSha256":"1256e043bdf20d8bf4955e5efbc63032d533c3beaf95dbd465e5ce109450a7c6"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the director agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the director agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.narrator','narrator v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.narrator';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the narrator agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'b6241d76ecb14e31c6ec7e82c99b19e65b2734620dab9a2e73436875b000f56d',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.narrator","templateName":"narrator v1","versionId":"VERSION_ID","version":1,"checksumSha256":"b6241d76ecb14e31c6ec7e82c99b19e65b2734620dab9a2e73436875b000f56d"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the narrator agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the narrator agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.critic','critic v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.critic';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the critic agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'3555510ceed040f556f20fd86e71705fc8cdc89c8cd98b21e139229da8f3aeae',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.critic","templateName":"critic v1","versionId":"VERSION_ID","version":1,"checksumSha256":"3555510ceed040f556f20fd86e71705fc8cdc89c8cd98b21e139229da8f3aeae"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the critic agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the critic agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.publisher','publisher v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.publisher';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the publisher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'3018b54eaa3637b6c0e75f526226d08ac4d8257abe1ab66a9cc4c87854dc8a8f',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.publisher","templateName":"publisher v1","versionId":"VERSION_ID","version":1,"checksumSha256":"3018b54eaa3637b6c0e75f526226d08ac4d8257abe1ab66a9cc4c87854dc8a8f"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the publisher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the publisher agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;

 tmpl := gen_random_uuid(); ver := gen_random_uuid();
 INSERT INTO prompt_templates (id,workspace_id,key,name,updated_at) VALUES (tmpl,tenant,'v1.analyst','analyst v1',now()) ON CONFLICT (workspace_id,key) DO NOTHING;
 SELECT id INTO tmpl FROM prompt_templates WHERE workspace_id=tenant AND key='v1.analyst';
 INSERT INTO prompt_template_versions (id,workspace_id,template_id,version,status,body,checksum_sha256,published_at)
 VALUES (ver,tenant,tmpl,1,'PUBLISHED','{"sections":{"instructions":"You are the analyst agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":[],"allowedAdditionSections":["instructions"]}'::jsonb,'06ff76e03f6b514dfaad33beaea96fe5dcd8e2e541e4ee5a685c8aa30a0b7ecf',now()) ON CONFLICT (workspace_id,template_id,version) DO NOTHING;
 SELECT id INTO ver FROM prompt_template_versions WHERE workspace_id=tenant AND template_id=tmpl AND version=1;
 UPDATE prompt_templates SET active_version_id=ver WHERE id=tmpl AND active_version_id IS NULL;
 payload := '{"formatVersion":"m05.1","configSha256":"fb4eb9a26e35c6d3cf9604f5d1759dd30a70157bf6d5c2a78e5cd37e6207945e","template":{"templateId":"TEMPLATE_ID","templateKey":"v1.analyst","templateName":"analyst v1","versionId":"VERSION_ID","version":1,"checksumSha256":"06ff76e03f6b514dfaad33beaea96fe5dcd8e2e541e4ee5a685c8aa30a0b7ecf"},"sections":{"system":"Platform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.","safety":"Safety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.","rights":"Rights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.","context":"","instructions":"You are the analyst agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.","examples":"","style":"","output":"Return a JSON object with evidence and explicit uncertainties."},"variables":{},"additions":[],"renderedText":"[system]\nPlatform system policy (m05-platform-v1, bundle format m05.1). Follow platform constraints. Never bypass safety, rights, or system requirements.\n\n[safety]\nSafety policy: minimum level standard; human review required: yes; blocked topics: medical advice, hate, graphic violence.\n\n[rights]\nRights policy: documented rights required: yes; unlicensed music allowed: no; allowed license types: CC0-1.0, CC-BY-4.0, USER_OWNED.\n\n[instructions]\nYou are the analyst agent for ReelForge. Return structured, evidence-backed output. Keep hook to 1–20 words, CTA to 1–15 words, and total spoken text within 210 words/minute. Never bypass rights, safety, budget or approval gates.\n\n[output]\nReturn a JSON object with evidence and explicit uncertainties.","protectedSections":["system","safety","rights"]}'::jsonb;
 payload := jsonb_set(jsonb_set(payload,'{template,templateId}',to_jsonb(tmpl::text)),'{template,versionId}',to_jsonb(ver::text));
 row_data := jsonb_build_object('formatVersion',payload->'formatVersion','configSha256',payload->'configSha256','template',(payload->'template')-'templateName','variables',payload->'variables','additions',payload->'additions','sections',payload->'sections');
 fingerprint := encode(sha256(convert_to(foundation_canonical_json(row_data),'UTF8')),'hex');
 payload := payload || jsonb_build_object('fingerprintSha256',fingerprint);
 INSERT INTO prompt_bundle_snapshots (id,workspace_id,version,config_snapshot_id,template_id,template_version_id,bundle,fingerprint_sha256)
 SELECT gen_random_uuid(),tenant,coalesce(max(version),0)+1,cfg,tmpl,ver,payload,fingerprint FROM prompt_bundle_snapshots WHERE workspace_id=tenant;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'explainer','explainer','{"opening":"hook","body":"explainer","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'top-3','top 3','{"opening":"hook","body":"top-3","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'story','story','{"opening":"hook","body":"story","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'myth-vs-fact','myth vs fact','{"opening":"hook","body":"myth-vs-fact","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'what-if','what if','{"opening":"hook","body":"what-if","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'history-moment','history moment','{"opening":"hook","body":"history-moment","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'quick-how-to','quick how to','{"opening":"hook","body":"quick-how-to","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;
INSERT INTO format_templates (id,workspace_id,key,name,structure) VALUES (gen_random_uuid(),tenant,'news-recap','news recap','{"opening":"hook","body":"news-recap","closing":"cta"}') ON CONFLICT (workspace_id,key,version) DO NOTHING;

 -- Compatibility genre for the existing M07 path; new briefs do not require M03 genre.
 INSERT INTO genres (id,workspace_id,name,audience,tone,topics_allowed,topics_blocked,language,structure,duration_preference,safety_profile,updated_at)
 SELECT gen_random_uuid(),tenant,'Explainer','General audience','Clear and friendly','["education","how-to"]','["hate"]','en','{"opening":"hook","body":"explain","closing":"cta"}','{"minSeconds":15,"maxSeconds":60}','{"level":"standard","requiresHumanReview":true,"requiresSourceBackedClaims":false}',now()
 WHERE NOT EXISTS (SELECT 1 FROM genres WHERE workspace_id=tenant AND name='Explainer');
 INSERT INTO workspace_foundation_defaults (id,workspace_id,settings) VALUES (gen_random_uuid(),tenant,'{"promptPackVersion":1,"agents":["planner","researcher","scriptwriter","storyboard","director","narrator","critic","publisher","analyst"],"formats":["explainer","top-3","story","myth-vs-fact","what-if","history-moment","quick-how-to","news-recap"],"renderProfile":{"id":"vertical-1080x1920-24-h264","width":1080,"height":1920,"fps":24,"videoCodec":"h264"},"budgetPolicy":{"currency":"USD","targetMinor":600,"hardCapMinor":800,"dailyLimitMinor":2000,"monthlyLimitMinor":18000},"autonomy":"L2","cadence":{"shortsPerDay":1,"localTime":"18:00","timezone":"CHANNEL"},"narrationLanguage":"English","aiDisclosure":true}'::jsonb);
END $$;

-- Apply defaults to current workspaces on migration. New workspace service calls the same function.
SELECT seed_workspace_foundations(id) FROM workspaces ORDER BY id;
