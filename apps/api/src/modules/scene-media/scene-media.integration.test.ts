import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { ProviderError, ProviderRegistry } from "@reelforge/ai-providers";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
import type {
  CapabilityMetadata,
  ImageProviderPort,
  TtsProviderPort,
  VideoProviderPort,
} from "@reelforge/ai-providers";
import { AssetService } from "../asset/asset.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import { sha256Hex } from "../asset/storage/checksum.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { PrismaSceneDispatchLedger } from "./scene-media.budget.js";
import { SceneMediaService } from "./scene-media.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ownerId = randomUUID();
const workspaceId = randomUUID();
const channelId = randomUUID();
const ideaId = randomUUID();
const snapshotId = randomUUID();
const budgetId = randomUUID();
const configSnapshotId = randomUUID();
const promptSnapshotId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
const scriptId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId: ownerId, role: "OWNER" };

function capability(kind: CapabilityMetadata["kind"], capabilityId: string): CapabilityMetadata {
  return {
    providerId: "fixture",
    capabilityId,
    kind,
    input: ["text"],
    output: [kind],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: 1 },
  };
}

const document = {
  schemaVersion: "1.0" as const,
  title: "Integration",
  hook: "Hook",
  dialogue: "Dialogue",
  cta: "CTA",
  metadata: { genre: "Integration", targetDurationSeconds: 2, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "",
      visualDescription: "First frame",
      camera: "wide",
      audioCues: [],
    },
    {
      id: "two",
      startSeconds: 1,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "",
      visualDescription: "Second frame",
      camera: "close",
      audioCues: [],
    },
  ],
};

suite("SceneMediaService persisted generation, budget, and media binding", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let storageRoot = "";
  let imageCalls = 0;
  let videoCalls = 0;
  let failImages = false;
  const image: ImageProviderPort = {
    capability: capability("image", "image"),
    generate: async (request) => {
      imageCalls += 1;
      if (failImages)
        throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
      return {
        mediaId: `img-${request.correlationId}`,
        providerJobId: `job-${request.correlationId}`,
        providerRequestId: `req-${request.correlationId}`,
        metadata: {
          modelVersion: "fixture-model",
          promptVersion: "fixture-prompt",
          cost: 1,
          currency: "USD",
        },
        media: { declaredMediaType: "image/png", body: PNG },
      };
    },
  };
  const video: VideoProviderPort = {
    capability: capability("image", "video"),
    generate: async () => {
      videoCalls += 1;
      throw new Error("video provider must not be called for a non-video capability");
    },
  };
  const tts: TtsProviderPort = {
    capability: capability("tts", "tts"),
    synthesize: async () => {
      throw new Error("tts must not run for this fixture");
    },
  };
  const registry = new ProviderRegistry();
  for (const port of [image, video, tts]) {
    registry.register({
      capability: port.capability,
      credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
    });
  }
  const storage = new LocalFilesystemStorageAdapter(join(tmpdir(), `reelforge-m09-${workspaceId}`));
  const service =
    db === undefined
      ? undefined
      : new SceneMediaService(
          db as Database,
          image,
          video,
          tts,
          registry,
          storage,
          new AssetService(db as Database, storage),
          new PrismaSceneDispatchLedger(db as Database),
        );

  beforeAll(async () => {
    if (!db) return;
    storageRoot = join(tmpdir(), `reelforge-m09-${workspaceId}`);
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@scene-media.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "scene-media" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "integration" } });
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
        expectedFormat: "short",
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
        expectedFormat: "short",
        checksumSha256: "checksum",
      },
    });
    const body = parsePromptTemplateBody({
      sections: { instructions: "Render {{topic}} as scene media." },
      variables: [{ name: "topic", required: true }],
      allowedAdditionSections: ["instructions"],
    });
    const bundle = compilePrompt({
      config: platformDefaults,
      template: {
        templateId,
        templateKey: "fixture-scene",
        templateName: "Fixture scene",
        versionId: templateVersionId,
        version: 1,
        checksumSha256: "a".repeat(64),
        body,
      },
      variables: { topic: "approved topic" },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "fixture-scene", name: "Fixture scene" },
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
      data: { id: budgetId, workspaceId, channelId, dailyLimit: 20, currency: "USD" },
    });
    await db.script.create({
      data: {
        id: scriptId,
        workspaceId,
        channelId,
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        status: "APPROVED",
        currentRevision: 1,
        approvedAt: new Date(),
        createdByUserId: ownerId,
        revisions: {
          create: {
            revision: 1,
            document,
            configSnapshotId,
            promptSnapshotId,
            promptText: bundle.renderedText,
            createdByUserId: ownerId,
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.sceneGenerationOutput.deleteMany({ where: { workspaceId } });
    await db.sceneGeneration.deleteMany({ where: { workspaceId } });
    await db.sceneMediaJob.deleteMany({ where: { workspaceId } });
    await db.assetUsageReference.deleteMany({ where: { workspaceId } });
    await db.asset.deleteMany({ where: { workspaceId } });
    await db.providerBudgetReservation.deleteMany({ where: { workspaceId } });
    await db.providerRequest.deleteMany({ where: { workspaceId } });
    await db.providerBudget.deleteMany({ where: { workspaceId } });
    await db.scriptRevision.deleteMany({ where: { workspaceId } });
    await db.script.deleteMany({ where: { workspaceId } });
    await db.promptBundleSnapshot.deleteMany({ where: { workspaceId } });
    await db.configSnapshot.deleteMany({ where: { workspaceId } });
    await db.promptTemplateVersion.deleteMany({ where: { workspaceId } });
    await db.promptTemplate.deleteMany({ where: { workspaceId } });
    await db.ideaApprovalSnapshot.deleteMany({ where: { workspaceId } });
    await db.idea.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("persists real media, checksums, and settled provider cost", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      idempotencyKey: "scene-media-success",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const requestsBefore = await db.providerRequest.count({ where: { workspaceId } });
    const again = await service.create(context, {
      scriptId,
      idempotencyKey: "scene-media-success",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const exported = await service.exportPackage(context, created.jobId);
    const budget = await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } });
    const requests = await db.providerRequest.findMany({
      where: { workspaceId, status: "SUCCEEDED" },
    });
    expect(again.jobId).toBe(created.jobId);
    expect(await db.providerRequest.count({ where: { workspaceId } })).toBe(requestsBefore);
    expect(imageCalls).toBe(2);
    expect(exported.status).toBe("SUCCEEDED");
    expect(exported.scenes.map((scene) => scene.idempotencyKey)).toEqual([
      `${created.jobId}:one:v1`,
      `${created.jobId}:two:v1`,
    ]);
    expect(budget.spent.toString()).toBe("2");
    expect(budget.reserved.toString()).toBe("0");
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (row) => row.actualCost?.toString() === "1" && row.estimatedCost?.toString() === "1",
      ),
    ).toBe(true);
    const asset = await db.asset.findFirstOrThrow({
      where: { id: exported.scenes[0]?.outputs[0]?.assetId ?? "" },
    });
    const bytes = await storage.getObject({ workspaceId, objectKey: asset.objectKey });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(sha256Hex(bytes)).toBe(exported.scenes[0]?.outputs[0]?.checksumSha256);
    expect(asset.status).toBe("PUBLISHED");
    expect(asset.ownership).toBe("SYSTEM_GENERATED");
  });

  it("reuses successful scenes when retry is requested", async () => {
    if (!service) return;
    const existing = await service.create(context, {
      scriptId,
      idempotencyKey: "scene-media-success",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const before = imageCalls;
    const retried = await service.retry(context, existing.jobId);
    expect(imageCalls).toBe(before);
    expect(
      retried.scenes.every((scene) => scene.sceneVersion === 1 && scene.status === "SUCCEEDED"),
    ).toBe(true);
  });

  it("releases the reservation and keeps a failed ledger row when the provider throws", async () => {
    if (!db || !service) return;
    const spentBefore = (
      await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } })
    ).spent.toString();
    failImages = true;
    const created = await service.create(context, {
      scriptId,
      idempotencyKey: "scene-media-failure",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    failImages = false;
    const budget = await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } });
    const failed = await db.providerRequest.findMany({
      where: { workspaceId, status: "FAILED", errorCode: "PROVIDER_UNAVAILABLE" },
    });
    const reservations = await db.providerBudgetReservation.findMany({
      where: { workspaceId, correlationId: { in: failed.map((row) => row.correlationId) } },
    });
    expect(created.status).toBe("FAILED");
    expect(
      created.scenes.every((scene) => scene.outputs.every((output) => output.assetId === null)),
    ).toBe(true);
    expect(budget.spent.toString()).toBe(spentBefore);
    expect(budget.reserved.toString()).toBe("0");
    expect(failed.length).toBeGreaterThan(0);
    expect(reservations.every((row) => row.status === "RELEASED")).toBe(true);
  });

  it("does not fabricate video when the configured capability is not video", async () => {
    if (!db || !service) return;
    const before = videoCalls;
    const created = await service.create(context, {
      scriptId,
      idempotencyKey: "scene-media-video",
      outputs: { image: true, video: true, narration: false, dialogue: false },
    });
    const videos = await db.asset.count({ where: { workspaceId, mediaType: "video/mp4" } });
    expect(videoCalls).toBe(before);
    expect(videos).toBe(0);
    expect(
      created.scenes.every((scene) =>
        scene.outputs.some((output) => output.kind === "VIDEO" && output.assetId === null),
      ),
    ).toBe(true);
    await expect(service.exportPackage(context, created.jobId)).rejects.toThrow(/incomplete/i);
  });
});
