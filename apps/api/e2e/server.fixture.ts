import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json } from "express";
import { Test } from "@nestjs/testing";
import { test } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import {
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  SCRIPT_LLM,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
  type CapabilityMetadata,
  type ImageProviderPort,
} from "@reelforge/ai-providers";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
import { AppModule } from "../src/app.module.js";
import { hashPassword } from "../src/modules/identity/auth.crypto.js";
import { LocalFilesystemStorageAdapter } from "../src/modules/asset/storage/local-storage.adapter.js";
import { STORAGE_PORT } from "../src/modules/asset/storage/storage.port.js";
import { CompositionService } from "../src/modules/composition/composition.service.js";
import { QualityService } from "../src/modules/quality/quality.service.js";
import type { ScriptLlmPort } from "../src/modules/script/script.types.js";
import { providerEnvironment } from "../src/modules/scene-media/scene-media.validation.js";

const document = {
  schemaVersion: "1.0" as const,
  title: "E2E story",
  hook: "Opening",
  dialogue: "",
  cta: "Try it",
  metadata: { genre: "E2E genre", targetDurationSeconds: 1, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "",
      visualDescription: "A blue background",
      camera: "wide",
      audioCues: [],
    },
  ],
};
function capability(kind: CapabilityMetadata["kind"], capabilityId: string): CapabilityMetadata {
  return {
    providerId: "fixture",
    capabilityId,
    kind,
    input: ["text"],
    output: kind === "llm" ? ["json"] : [kind],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: 1 },
  };
}

const metadata = {
  modelVersion: "fixture-model",
  promptVersion: "fixture-prompt",
  cost: 1,
  currency: "USD",
};
const llm: ScriptLlmPort = {
  capability: capability("llm", "llm"),
  complete: async () => ({ output: document, metadata }),
};

test("isolated offline API fixture", async () => {
  if (
    process.env.REELFORGE_E2E !== "1" ||
    !process.env.E2E_STORAGE_ROOT ||
    !process.env.DATABASE_URL?.includes("/reelforge_e2e")
  )
    throw new Error("Use pnpm test:e2e; only disposable infrastructure is allowed");
  // Even an accidentally un-overridden HTTP provider fails before making a network call.
  globalThis.fetch = async (): Promise<never> => {
    throw new Error("Outbound HTTP forbidden in E2E API");
  };
  process.env.YOUTUBE_OAUTH_CLIENT_ID = "e2e-offline";
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "e2e-offline";
  process.env.YOUTUBE_OAUTH_CALLBACK_URL =
    "http://127.0.0.1:3301/api/v1/social-accounts/oauth/youtube/callback";
  const db = createDatabaseClient(process.env.DATABASE_URL);
  const root = process.env.E2E_STORAGE_ROOT;
  const storage = new LocalFilesystemStorageAdapter(root);
  const pngPath = join(root, "source.png");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1080x1920",
      "-frames:v",
      "1",
      "-threads",
      "1",
      pngPath,
    ],
    { stdio: "ignore" },
  );
  const PNG = await readFile(pngPath);
  const image: ImageProviderPort = {
    capability: capability("image", "image"),
    generate: async (request) => ({
      mediaId: `e2e-${request.correlationId}`,
      providerJobId: `e2e-job-${request.correlationId}`,
      providerRequestId: `e2e-request-${request.correlationId}`,
      media: { declaredMediaType: "image/png", body: PNG },
      metadata,
    }),
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected test provider call");
  };
  const video = { capability: capability("image", "video"), generate: unavailable };
  const tts = { capability: capability("tts", "tts"), synthesize: unavailable };
  const registry = new ProviderRegistry();
  for (const port of [llm, image, video, tts])
    registry.register({
      capability: port.capability,
      credential: {
        providerId: "fixture",
        environment: port === llm ? "development" : providerEnvironment(),
        secret: "test-only",
      },
    });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider("DATABASE")
    .useValue(db)
    .overrideProvider(SCRIPT_LLM)
    .useValue(llm)
    .overrideProvider(PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(IMAGE_PROVIDER)
    .useValue(image)
    .overrideProvider(VIDEO_PROVIDER)
    .useValue(video)
    .overrideProvider(TTS_PROVIDER)
    .useValue(tts)
    .overrideProvider(STORAGE_PORT)
    .useValue(storage)
    .compile();
  const seeds = [];
  for (const width of [390, 1440]) {
    const ownerId = randomUUID(),
      workspaceId = randomUUID(),
      channelId = randomUUID(),
      genreId = randomUUID(),
      ideaId = randomUUID(),
      snapshotId = randomUUID(),
      configSnapshotId = randomUUID(),
      promptSnapshotId = randomUUID(),
      templateId = randomUUID(),
      templateVersionId = randomUUID(),
      socialAccountId = randomUUID();
    const email = `owner-${width}@e2e.invalid`;
    await db.user.create({
      data: {
        id: ownerId,
        email,
        credential: { create: { passwordHash: await hashPassword("E2e-only-password-79!") } },
      },
    });
    await db.workspace.create({ data: { id: workspaceId, name: `E2E Owner ${width}` } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    for (const role of ["EDITOR", "VIEWER"] as const) {
      const other = await db.workspace.create({ data: { name: `E2E ${role} ${width}` } });
      await db.workspaceMembership.create({
        data: { workspaceId: other.id, userId: ownerId, role },
      });
    }
    await db.channel.create({ data: { id: channelId, workspaceId, name: `Production ${width}` } });
    await db.genre.create({
      data: {
        id: genreId,
        workspaceId,
        name: "E2E genre",
        audience: "all",
        tone: "plain",
        topicsAllowed: [],
        topicsBlocked: [],
        language: "en",
        structure: {},
        durationPreference: {},
        safetyProfile: { requiresSourceBackedClaims: false },
      },
    });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "Approved",
        normalizedTitle: "approved",
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        approvedAt: new Date(),
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        ideaId,
        channelId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        checksumSha256: "a".repeat(64),
      },
    });
    const body = parsePromptTemplateBody({
      sections: { instructions: "Write a structured script for {{topic}}." },
      variables: [{ name: "topic", required: true }],
      allowedAdditionSections: ["instructions"],
    });
    const bundle = compilePrompt({
      config: platformDefaults,
      template: {
        templateId,
        templateKey: "m16-script",
        templateName: "M16 script",
        versionId: templateVersionId,
        version: 1,
        checksumSha256: "a".repeat(64),
        body,
      },
      variables: { topic: "approved topic" },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "m16-script", name: "M16 script" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body,
        checksumSha256: "a".repeat(64),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
        workspaceId,
        version: 1,
        config: platformDefaults,
        fingerprintSha256: "b".repeat(64),
        resolutionSha256: "c".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptSnapshotId,
        workspaceId,
        version: 1,
        configSnapshotId,
        templateId,
        templateVersionId,
        bundle,
        fingerprintSha256: bundle.fingerprintSha256,
      },
    });
    await db.providerBudget.create({
      data: { workspaceId, channelId, dailyLimit: 100, currency: "USD" },
    });
    await db.socialAccount.create({
      data: {
        id: socialAccountId,
        workspaceId,
        channelId,
        platform: "YOUTUBE",
        remoteAccountId: `m16-${socialAccountId}`,
        displayName: "E2E YouTube",
        health: "HEALTHY",
      },
    });

    const assetId = randomUUID();
    const stored = await storage.putObject({
      workspaceId,
      objectKey: `e2e/${assetId}.png`,
      body: PNG,
      contentType: "image/png",
    });
    await db.asset.create({
      data: {
        id: assetId,
        workspaceId,
        rootAssetId: assetId,
        ...stored,
        mediaType: "image/png",
        filename: "Reusable blue.png",
        status: "PUBLISHED",
        licenseType: "CC0",
        licenseTerms: "Public-domain test fixture",
        rightsHolder: "E2E fixture",
        rightsAttestedAt: new Date(),
        createdByUserId: ownerId,
      },
    });
    seeds.push({
      width,
      email,
      workspaceId,
      channelId,
      ideaId,
      configSnapshotId,
      promptSnapshotId,
      assetId,
    });
  }
  await writeFile(join(root, "seed.json"), JSON.stringify(seeds));
  const app = module.createNestApplication({ bodyParser: false });
  app.use(json({ limit: "40mb" }));
  app.setGlobalPrefix("api/v1");
  await app.listen(3301, "127.0.0.1");
  const composition = module.get(CompositionService),
    quality = module.get(QualityService);
  let draining = false;
  const worker = setInterval(() => {
    if (draining) return;
    draining = true;
    void (async (): Promise<void> => {
      const jobs = await db.renderJob.findMany({ where: { status: "QUEUED" } });
      for (const job of jobs) await composition.runClaim(job.id);
      const unreviewed = await db.renderJob.findMany({
        where: { status: "SUCCEEDED", qualityReviewRuns: { none: {} } },
      });
      for (const job of unreviewed)
        await quality.create(
          { workspaceId: job.workspaceId, userId: job.createdByUserId, role: "OWNER" },
          { renderJobId: job.id },
        );
    })()
      .catch((error: unknown) => {
        console.error("E2E render worker failed", error);
      })
      .finally(() => {
        draining = false;
      });
  }, 250);
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    clearInterval(worker);
    await app.close();
    await db.$disconnect();
  }
});
