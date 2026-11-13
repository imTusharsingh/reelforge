import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { ProviderError, ProviderRegistry } from "@reelforge/ai-providers";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
import type {
  CapabilityMetadata,
  ImageProviderPort,
  MediaGenerationResponse,
  TtsProviderPort,
  VideoProviderPort,
} from "@reelforge/ai-providers";
import { AssetService } from "../asset/asset.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import { sha256Hex } from "../asset/storage/checksum.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { PrismaSceneDispatchLedger } from "./scene-media.budget.js";
import { SceneMediaService } from "./scene-media.service.js";
import { providerEnvironment } from "./scene-media.validation.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ImageGate = Readonly<{
  entered: Promise<void>;
  released: Promise<void>;
  signalEntered: () => void;
  release: () => void;
}>;

function makeImageGate(): ImageGate {
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve): void => {
    signalEntered = resolve;
  });
  const released = new Promise<void>((resolve): void => {
    release = resolve;
  });
  return { entered, released, signalEntered, release };
}
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
  let imageGate: ImageGate | null = null;
  let videoCalls = 0;
  let failImages = false;
  let metadataMode: "complete" | "missing" | "null" | "non-object" | "omit-usage" = "complete";
  const image: ImageProviderPort = {
    capability: capability("image", "image"),
    generate: async (request): Promise<MediaGenerationResponse> => {
      imageCalls += 1;
      const gate = imageGate;
      if (gate) {
        gate.signalEntered();
        await gate.released;
      }
      if (failImages)
        throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
      const media = {
        mediaId: `img-${request.correlationId}`,
        providerJobId: `job-${request.correlationId}`,
        providerRequestId: `req-${request.correlationId}`,
        media: { declaredMediaType: "image/png", body: PNG },
      };
      if (metadataMode === "missing") return media as unknown as MediaGenerationResponse;
      if (metadataMode === "null")
        return { ...media, metadata: null } as unknown as MediaGenerationResponse;
      if (metadataMode === "non-object")
        return { ...media, metadata: "bad" } as unknown as MediaGenerationResponse;
      if (metadataMode === "omit-usage") {
        return {
          ...media,
          metadata: { modelVersion: "fixture-model", promptVersion: "fixture-prompt", cost: 1 },
        };
      }
      return {
        ...media,
        metadata: {
          modelVersion: "fixture-model",
          promptVersion: "fixture-prompt",
          cost: 1,
          currency: "USD",
        },
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
      credential: {
        providerId: "fixture",
        environment: providerEnvironment(),
        secret: "fixture-secret",
      },
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
      data: { id: budgetId, workspaceId, channelId, dailyLimit: 100, currency: "USD" },
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
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-success",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const requestsBefore = await db.providerRequest.count({ where: { workspaceId } });
    const again = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
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

  it("persists assignment, replay, usage and export without provider or paid reservation calls", async () => {
    if (!db || !service) return;
    const job = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: randomUUID(),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const assetId = job.scenes[1]!.outputs[0]!.assetId!;
    const request = {
      expectedJobVersion: job.version,
      idempotencyKey: randomUUID(),
      kind: "IMAGE",
      assetId,
      assetVersion: 1,
    };
    const before = imageCalls;
    const reserve = vi.fn();
    Object.assign(service, { usage: { reservePaidCall: reserve } });
    try {
      const result = await service.assignAsset(context, job.jobId, "one", request);
      expect(result.scenes[0]!.outputs[0]).toMatchObject({
        status: "ASSIGNED",
        assetId,
        providerJobId: null,
        providerAssetId: null,
      });
      expect(await service.assignAsset(context, job.jobId, "one", request)).toEqual(result);
      expect(await service.exportPackage(context, job.jobId)).toMatchObject({
        status: "SUCCEEDED",
      });
      const assigned = await db.sceneGenerationOutput.findFirstOrThrow({
        where: {
          workspaceId,
          status: "ASSIGNED",
          sceneGeneration: { jobId: job.jobId, activeSlot: 1 },
        },
      });
      expect(
        await db.assetUsageReference.findFirst({
          where: {
            workspaceId,
            assetId,
            usedByType: "scene_generation_output",
            usedById: assigned.id,
          },
        }),
      ).not.toBeNull();
      await expect(
        service.assignAsset(context, job.jobId, "one", { ...request, assetId: randomUUID() }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.assignAsset(context, job.jobId, "one", {
          ...request,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(imageCalls).toBe(before);
      expect(reserve).not.toHaveBeenCalled();
    } finally {
      Object.assign(service, { usage: undefined });
    }
  });

  it.each([
    ["VIEWER", 403],
    ["FOREIGN", 404],
    ["PENDING", 409],
    ["KIND", 422],
  ] as const)("rejects %s assignment in Postgres", async (scenario, status) => {
    if (!db || !service) return;
    const job = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: randomUUID(),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const assetId = job.scenes[0]!.outputs[0]!.assetId!;
    if (scenario === "PENDING")
      await db.asset.update({ where: { id: assetId }, data: { status: "PENDING" } });
    if (scenario === "KIND")
      await db.asset.update({ where: { id: assetId }, data: { mediaType: "audio/wav" } });
    const before = imageCalls;
    await expect(
      service.assignAsset(
        { ...context, role: scenario === "VIEWER" ? "VIEWER" : "EDITOR" },
        job.jobId,
        "one",
        {
          expectedJobVersion: job.version,
          idempotencyKey: randomUUID(),
          kind: "IMAGE",
          assetId: scenario === "FOREIGN" ? randomUUID() : assetId,
          assetVersion: 1,
        },
      ),
    ).rejects.toMatchObject({ status });
    expect(imageCalls).toBe(before);
  });

  it("reuses successful scenes when retry is requested", async () => {
    if (!service) return;
    const existing = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-success",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const before = imageCalls;
    const retried = await service.retry(context, existing.jobId, {
      idempotencyKey: "scene-media-retry",
      expectedJobVersion: existing.version,
    });
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
      expectedScriptRevision: 1,
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
      expectedScriptRevision: 1,
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

  it.each(["missing", "null", "non-object"] as const)(
    "persists a terminal failed ledger for %s metadata",
    async (mode) => {
      if (!db || !service) return;
      metadataMode = mode;
      const idempotencyKey = `scene-media-${mode}`;
      const created = await service.create(context, {
        scriptId,
        expectedScriptRevision: 1,
        idempotencyKey,
        outputs: { image: true, video: false, narration: false, dialogue: false },
      });
      metadataMode = "complete";
      expect(created.status).toBe("FAILED");
      const requests = await db.providerRequest.findMany({
        where: { workspaceId, dispatchedPrompt: { contains: "Scene:" } },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.status).toBe("FAILED");
        expect(request.errorCode).not.toBe("PENDING");
        expect(request.errorMessage).toContain("invalid provenance");
        expect(request.actualCost).toBeNull();
        expect(request.usage).toBeNull();
        expect(request.currency).toBe("USD");
        expect(request.dispatchedPrompt?.length).toBeGreaterThan(0);
        expect(request.latencyMs).toEqual(expect.any(Number));
        expect(request.responseMetadata).toMatchObject({ dispatched: true, costKnown: false });
        const reservation = await db.providerBudgetReservation.findUniqueOrThrow({
          where: {
            workspaceId_correlationId: { workspaceId, correlationId: request.correlationId },
          },
        });
        expect(reservation.status).toBe("SETTLED");
        expect(reservation.actualCost).toBeNull();
        expect(reservation.chargedCost?.toString()).toBe("1");
      }
      expect(
        created.scenes.every((scene) => scene.outputs.every((output) => output.assetId === null)),
      ).toBe(true);
    },
  );

  it("persists omitted usage as JSON null and a succeeded ledger", async () => {
    if (!db || !service) return;
    metadataMode = "omit-usage";
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-omit-usage",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    metadataMode = "complete";
    expect(created.status).toBe("SUCCEEDED");
    const output = created.scenes[0]?.outputs[0];
    const request = await db.providerRequest.findUniqueOrThrow({
      where: {
        workspaceId_correlationId: { workspaceId, correlationId: output?.correlationId ?? "" },
      },
    });
    expect(request.status).toBe("SUCCEEDED");
    expect(request.errorCode).toBeNull();
    expect(request.usage).toBeNull();
    expect(request.currency).toBe("USD");
    expect(request.actualCost?.toString()).toBe("1");
    expect(request.estimatedCost?.toString()).toBe("1");
    expect(request.responseMetadata).toMatchObject({
      dispatched: true,
      costKnown: true,
      modelVersion: "fixture-model",
      promptVersion: "fixture-prompt",
    });
    const reservation = await db.providerBudgetReservation.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId: request.correlationId } },
    });
    expect(reservation.status).toBe("SETTLED");
    expect(reservation.actualCost?.toString()).toBe("1");
  });

  it("lists direct jobs across the workspace without relying on usage ledger rows", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-list",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const page = await service.list(
      { ...context, role: "VIEWER" },
      {
        scriptId,
        channelId,
        status: "SUCCEEDED",
        page: 1,
        pageSize: 1,
      },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ jobId: expect.any(String), scriptId, channelId });
    expect(page.nextPage).toBe(2);
    const all = await service.list(context, {
      scriptId,
      channelId,
      status: "SUCCEEDED",
      page: 1,
      pageSize: 100,
    });
    expect(all.items.some((item) => item.jobId === created.jobId)).toBe(true);
    expect(
      all.items.every((item) => item.scriptId === scriptId && item.channelId === channelId),
    ).toBe(true);
    const foreign = await service.list(
      { ...context, workspaceId: randomUUID() },
      { page: 1, pageSize: 25 },
    );
    expect(foreign.items).toHaveLength(0);
    const wrongChannel = await service.list(context, {
      channelId: randomUUID(),
      page: 1,
      pageSize: 25,
    });
    expect(wrongChannel.items).toHaveLength(0);
  });

  it("rejects a stale observed approved revision before creating a job", async () => {
    if (!db || !service) return;
    const jobsBefore = await db.sceneMediaJob.count({ where: { workspaceId } });
    await expect(
      service.create(context, {
        scriptId,
        expectedScriptRevision: 2,
        idempotencyKey: "scene-media-stale-revision",
        outputs: { image: true, video: false, narration: false, dialogue: false },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await db.sceneMediaJob.count({ where: { workspaceId } })).toBe(jobsBefore);
  });

  it("retries from the pinned historical revision instead of the newer approved script", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-pinned-history",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    await db.scriptRevision.create({
      data: {
        workspaceId,
        scriptId,
        revision: 2,
        document: {
          ...document,
          scenes: [{ ...document.scenes[0], id: "three", visualDescription: "Newer frame" }],
        },
        configSnapshotId,
        promptSnapshotId,
        promptText: "newer revision",
        createdByUserId: ownerId,
      },
    });
    await db.script.update({
      where: { workspaceId_id: { workspaceId, id: scriptId } },
      data: { currentRevision: 2 },
    });
    try {
      const retried = await service.retry(context, created.jobId, {
        idempotencyKey: "scene-media-pinned-history-retry",
        expectedJobVersion: created.version,
      });
      expect(retried.scriptRevision).toBe(1);
      expect(retried.scenes.map((scene) => scene.sceneId)).toEqual(["one", "two"]);
      expect(retried.configSnapshotId).toBe(created.configSnapshotId);
      expect(retried.promptSnapshotId).toBe(created.promptSnapshotId);
    } finally {
      await db.script.update({
        where: { workspaceId_id: { workspaceId, id: scriptId } },
        data: { currentRevision: 1 },
      });
      await db.scriptRevision.delete({
        where: { workspaceId_scriptId_revision: { workspaceId, scriptId, revision: 2 } },
      });
    }
  });

  it("reconciles replayed mutations and rejects stale versions or key reuse", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-mutation-replay",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const requestsBefore = await db.providerRequest.count({ where: { workspaceId } });
    const request = {
      idempotencyKey: "scene-media-mutation-replay-key",
      expectedJobVersion: created.version,
    };
    const first = await service.retry(context, created.jobId, request);
    const replay = await service.retry(context, created.jobId, request);
    expect(replay.version).toBe(first.version);
    expect(await db.providerRequest.count({ where: { workspaceId } })).toBe(requestsBefore);
    await expect(service.regenerate(context, created.jobId, "one", request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      service.retry(context, created.jobId, {
        idempotencyKey: "scene-media-mutation-stale",
        expectedJobVersion: created.version,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await db.sceneMediaMutation.count({ where: { workspaceId, jobId: created.jobId } }),
    ).toBe(1);
  });

  it("allows exactly one concurrent mutation claim for an observed job version", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-concurrent-mutation",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const results = await Promise.allSettled([
      service.retry(context, created.jobId, {
        idempotencyKey: "scene-media-concurrent-a",
        expectedJobVersion: created.version,
      }),
      service.retry(context, created.jobId, {
        idempotencyKey: "scene-media-concurrent-b",
        expectedJobVersion: created.version,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ConflictException);
    const current = await service.get(context, created.jobId);
    expect(current.version).toBe(created.version + 1);
    expect(
      await db.sceneMediaMutation.count({ where: { workspaceId, jobId: created.jobId } }),
    ).toBe(1);
  });

  it("blocks a different-key mutation while a paid mutation is in flight", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-lease-mutation",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const gate = makeImageGate();
    imageGate = gate;
    try {
      const first = service.regenerate(context, created.jobId, "one", {
        idempotencyKey: "scene-media-lease-a",
        expectedJobVersion: created.version,
      });
      await gate.entered;
      const callsWhileHeld = imageCalls;
      await expect(
        service.regenerate(context, created.jobId, "one", {
          idempotencyKey: "scene-media-lease-b",
          expectedJobVersion: created.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageCalls).toBe(callsWhileHeld);
      gate.release();
      const result = await first;
      expect(result.version).toBe(created.version + 1);
      const settled = await db.sceneMediaJob.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: created.jobId } },
      });
      expect(settled.leaseId).toBeNull();
      expect(settled.leaseExpiresAt).toBeNull();
    } finally {
      gate.release();
      imageGate = null;
    }
  });

  it("blocks mutations while the initial creation dispatch is in flight", async () => {
    if (!db || !service) return;
    const gate = makeImageGate();
    imageGate = gate;
    try {
      const creating = service.create(context, {
        scriptId,
        expectedScriptRevision: 1,
        idempotencyKey: "scene-media-lease-create",
        outputs: { image: true, video: false, narration: false, dialogue: false },
      });
      await gate.entered;
      const job = await db.sceneMediaJob.findFirstOrThrow({
        where: { workspaceId, idempotencyKey: "scene-media-lease-create" },
      });
      const callsWhileHeld = imageCalls;
      await expect(
        service.retry(context, job.id, {
          idempotencyKey: "scene-media-lease-during-create",
          expectedJobVersion: job.version,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageCalls).toBe(callsWhileHeld);
      gate.release();
      const created = await creating;
      expect(created.status).toBe("SUCCEEDED");
      const settled = await db.sceneMediaJob.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: job.id } },
      });
      expect(settled.leaseId).toBeNull();
      expect(settled.leaseExpiresAt).toBeNull();
    } finally {
      gate.release();
      imageGate = null;
    }
  });

  it("refuses an expired-lease takeover while paid provider work is unresolved", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-lease-expiry-inflight",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    const gate = makeImageGate();
    imageGate = gate;
    try {
      const first = service.regenerate(context, created.jobId, "one", {
        idempotencyKey: "scene-media-inflight-owner",
        expectedJobVersion: created.version,
      });
      await gate.entered;
      await db.sceneMediaJob.update({
        where: { workspaceId_id: { workspaceId, id: created.jobId } },
        data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
      });
      const callsWhileHeld = imageCalls;
      await expect(
        service.regenerate(context, created.jobId, "one", {
          idempotencyKey: "scene-media-inflight-takeover",
          expectedJobVersion: created.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageCalls).toBe(callsWhileHeld);
      const held = await db.sceneMediaJob.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: created.jobId } },
      });
      expect(held.version).toBe(created.version + 1);
      gate.release();
      await expect(first).rejects.toBeInstanceOf(ConflictException);
      const afterStaleOwner = await db.sceneMediaJob.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: created.jobId } },
      });
      expect(afterStaleOwner.leaseId).not.toBeNull();
      await expect(
        service.regenerate(context, created.jobId, "one", {
          idempotencyKey: "scene-media-after-expired-owner",
          expectedJobVersion: created.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageCalls).toBe(callsWhileHeld);
    } finally {
      gate.release();
      imageGate = null;
    }
  });

  it("recovers an expired operation lease and reconciles the stale mutation", async () => {
    if (!db || !service) return;
    const created = await service.create(context, {
      scriptId,
      expectedScriptRevision: 1,
      idempotencyKey: "scene-media-lease-recovery",
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    await db.sceneMediaJob.update({
      where: { workspaceId_id: { workspaceId, id: created.jobId } },
      data: {
        leaseId: "crashed-operation",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const stale = await db.sceneMediaMutation.create({
      data: {
        workspaceId,
        jobId: created.jobId,
        operation: "RETRY",
        status: "IN_PROGRESS",
        idempotencyKey: "scene-media-lease-crashed",
        expectedJobVersion: created.version,
        payloadHash: "stale",
        payload: {},
        sceneIds: [],
        sceneVersionBefore: 0,
        createdByUserId: ownerId,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const retried = await service.retry(context, created.jobId, {
      idempotencyKey: "scene-media-lease-recovery-retry",
      expectedJobVersion: created.version,
    });
    expect(retried.version).toBe(created.version + 1);
    const reconciled = await db.sceneMediaMutation.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: stale.id } },
    });
    expect(reconciled.status).toBe("FAILED");
    expect(reconciled.errorCode).toBe("STALE_OPERATION");
  });
});
