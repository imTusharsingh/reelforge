import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { MediaValidationError } from "@reelforge/media";
import { AssetService } from "../asset/asset.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionEnginePort, RenderedArtifact } from "./composition.engine.js";
import { CompositionService } from "./composition.service.js";
import type { RenderCompositionInput } from "./composition.types.js";
import { createRenderSchema, parse } from "./composition.validation.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userId = randomUUID();
const scriptId = randomUUID();
const sceneGenerationId = randomUUID();
const sceneMediaJobId = randomUUID();
const visualAssetId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId, role: "OWNER" };

function body(
  idempotencyKey: string,
  input?: Partial<RenderCompositionInput>,
): {
  idempotencyKey: string;
  retentionDays: number;
  input: RenderCompositionInput;
} {
  return {
    idempotencyKey,
    retentionDays: 30,
    input: {
      schemaVersion: "1.0" as const,
      title: "M10 persisted render",
      profile: {
        id: "vertical-1080x1920-30-h264",
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "aac",
        audioSampleRate: 48000,
        audioChannels: 2,
        captionSafeMarginPixels: 120,
        transition: "CUT",
        transitionDurationMs: 0,
      },
      sourceMediaPackage: {
        jobId: sceneMediaJobId,
        scriptId,
        scriptRevision: 1,
        schemaVersion: "1.0",
      },
      scenes: [
        {
          sceneId: "scene-one",
          assetId: visualAssetId,
          assetVersion: 1,
          image: true,
          durationMs: 1000,
          captions: [{ text: "Validated", startMs: 0, endMs: 500 }],
        },
      ],
      audio: [],
      coverFrames: [{ assetId: visualAssetId, assetVersion: 1, timestampMs: 0 }],
      renderSeed: "persisted-seed",
      ...input,
    },
  };
}

function validArtifacts(
  input: RenderCompositionInput,
  jobId = "fixture-job",
): readonly RenderedArtifact[] {
  const videoBody = Buffer.from("validated fixture video");
  const manifest = {
    schemaVersion: "1.0",
    jobId,
    title: input.title,
    renderSeed: input.renderSeed,
    renderProfile: input.profile,
    sourceMediaPackage: input.sourceMediaPackage,
    pinnedInputs: { scenes: input.scenes, audio: input.audio, coverFrames: input.coverFrames },
    video: {
      filename: "final.mp4",
      mediaType: "video/mp4",
      byteSize: videoBody.length,
      checksumSha256: createHash("sha256").update(videoBody).digest("hex"),
      durationMs: 1000,
    },
    artifactOrder: ["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"],
  };
  return [
    {
      kind: "VIDEO",
      body: videoBody,
      mediaType: "video/mp4",
      filename: "final.mp4",
      durationMs: 1000,
    },
    ...input.coverFrames.map((selectedFrame, index) => ({
      kind: "COVER" as const,
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9, index]),
      mediaType: "image/jpeg",
      filename: `cover-${index + 1}.jpg`,
      durationMs: null,
      selectedFrame,
    })),
    {
      kind: "MANIFEST",
      body: Buffer.from(JSON.stringify(manifest)),
      mediaType: "application/json",
      filename: "manifest.json",
      durationMs: null,
    },
  ];
}

suite("CompositionService persisted lifecycle", () => {
  const db = databaseUrl ? createDatabaseClient(databaseUrl) : undefined;
  const storageRoot = join(tmpdir(), `reelforge-m10-integration-${workspaceId}`);
  const storage = new LocalFilesystemStorageAdapter(storageRoot);
  let fail = true;
  let calls = 0;
  let wait: Promise<void> = Promise.resolve();
  let engineEntered = (): void => {};
  let entered: Promise<void> = Promise.resolve();
  let corruptManifest = false;
  let invalidMedia = false;
  const engine: CompositionEnginePort = {
    execute: async (_context, _jobId, input, signal) => {
      calls += 1;
      engineEntered();
      if (signal?.aborted)
        throw Object.assign(new Error("Render canceled"), { name: "AbortError" });
      await wait;
      if (signal?.aborted)
        throw Object.assign(new Error("Render canceled"), { name: "AbortError" });
      if (invalidMedia)
        throw new MediaValidationError("Pinned source media failed technical validation");
      if (fail) throw new Error("transient renderer failure");
      return corruptManifest
        ? validArtifacts(input, _jobId).map((artifact) =>
            artifact.kind !== "MANIFEST"
              ? artifact
              : {
                  ...artifact,
                  body: Buffer.from(
                    JSON.stringify({
                      schemaVersion: "1.0",
                      video: { checksumSha256: "0".repeat(64) },
                    }),
                  ),
                },
          )
        : validArtifacts(input, _jobId);
    },
  };
  const assetReference = {
    getReference: async (
      _context: WorkspaceContext,
      request: { assetId: string; version: number },
    ) => ({
      assetId: request.assetId,
      version: request.version,
      objectKey: "fixtures/checksummed-media",
      byteSize: 8,
      checksumSha256: "a".repeat(64),
      mediaType: "audio/wav",
      licenseType: "CC0-1.0",
      rightsHolder: "fixture",
    }),
  } as AssetService;
  const service = db
    ? new CompositionService(db as Database, engine, storage, assetReference)
    : undefined;

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({ data: { id: userId, email: `${userId}@m10-lifecycle.invalid` } });
    if (!databaseUrl) throw new Error("Database fixture requires DATABASE_URL");
    const channelId = randomUUID();
    const ideaId = randomUUID();
    const approvalId = randomUUID();
    const configId = randomUUID();
    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    const promptId = randomUUID();
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m10" },
        { id: otherWorkspaceId, name: "foreign" },
      ],
    });
    await db.workspaceMembership.create({ data: { workspaceId, userId, role: "OWNER" } });
    await db.asset.create({
      data: {
        id: visualAssetId,
        workspaceId,
        objectKey: "fixtures/visual.png",
        mediaType: "image/png",
        byteSize: 8,
        checksumSha256: "a".repeat(64),
        version: 1,
        rootAssetId: visualAssetId,
        ownership: "SYSTEM_GENERATED",
        status: "PUBLISHED",
        licenseType: "CC0-1.0",
        rightsHolder: "fixture",
      },
    });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "m10-fixture" } });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "M10 fixture",
        normalizedTitle: "m10 fixture",
        topic: "fixture",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        createdByUserId: userId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: approvalId,
        workspaceId,
        ideaId,
        channelId,
        topic: "fixture",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        checksumSha256: "b".repeat(64),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configId,
        workspaceId,
        version: 1,
        config: {},
        fingerprintSha256: "c".repeat(64),
        resolutionSha256: "d".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "m10", name: "M10" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body: { sections: { instructions: "fixture" }, variables: [], allowedAdditionSections: [] },
        checksumSha256: "e".repeat(64),
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptId,
        workspaceId,
        version: 1,
        configSnapshotId: configId,
        templateId,
        templateVersionId,
        bundle: {
          schemaVersion: "1.0",
          renderedText: "fixture",
          fingerprintSha256: "f".repeat(64),
        },
        fingerprintSha256: "f".repeat(64),
      },
    });
    await db.script.create({
      data: {
        id: scriptId,
        workspaceId,
        channelId,
        approvedIdeaSnapshotId: approvalId,
        approvedIdeaChecksum: "b".repeat(64),
        status: "APPROVED",
        currentRevision: 1,
        approvedAt: new Date(),
        createdByUserId: userId,
        revisions: {
          create: {
            revision: 1,
            document: {},
            configSnapshotId: configId,
            promptSnapshotId: promptId,
            promptText: "fixture",
            createdByUserId: userId,
          },
        },
      },
    });
    const fixture = async (): Promise<void> => {
      await db.sceneMediaJob.create({
        data: {
          id: sceneMediaJobId,
          workspaceId,
          scriptId,
          scriptRevision: 1,
          channelId,
          configSnapshotId: configId,
          promptSnapshotId: promptId,
          idempotencyKey: "m10-integration",
          requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
          status: "SUCCEEDED",
          schemaVersion: "1.0",
          createdByUserId: userId,
          scenes: {
            create: {
              id: sceneGenerationId,
              sceneId: "scene-one",
              ordinal: 0,
              sceneVersion: 1,
              status: "SUCCEEDED",
              idempotencyKey: "m10-integration-scene",
              resolvedPrompt: "fixture",
              sourceRefs: {},
              activeSlot: 1,
              outputs: {
                create: {
                  id: randomUUID(),
                  kind: "IMAGE",
                  status: "SUCCEEDED",
                  assetId: visualAssetId,
                  assetVersion: 1,
                  providerJobId: "m10-fixture-job",
                  providerAssetId: "m10-fixture-asset",
                  mediaType: "image/png",
                  byteSize: 8,
                  checksumSha256: "a".repeat(64),
                },
              },
            },
          },
        },
      });
    };
    await fixture();
  });

  afterAll(async () => {
    if (!db) return;
    await db.renderJob.updateMany({ where: { workspaceId }, data: { parentJobId: null } });
    await db.renderArtifact.deleteMany({ where: { workspaceId } });
    await db.renderJob.deleteMany({ where: { workspaceId } });
    await db.sceneGenerationOutput.deleteMany({ where: { workspaceId } });
    await db.sceneGeneration.deleteMany({ where: { workspaceId } });
    await db.sceneMediaJob.deleteMany({ where: { workspaceId } });
    await db.assetUsageReference.deleteMany({ where: { workspaceId } });
    await db.asset.deleteMany({ where: { workspaceId } });
    await db.scriptRevision.deleteMany({ where: { workspaceId } });
    await db.script.deleteMany({ where: { workspaceId } });
    await db.promptBundleSnapshot.deleteMany({ where: { workspaceId } });
    await db.configSnapshot.deleteMany({ where: { workspaceId } });
    await db.promptTemplateVersion.deleteMany({ where: { workspaceId } });
    await db.promptTemplate.deleteMany({ where: { workspaceId } });
    await db.ideaApprovalSnapshot.deleteMany({ where: { workspaceId } });
    await db.idea.deleteMany({ where: { workspaceId } });
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("persists attachments only after successful export and replays the same idempotency key", async () => {
    if (!db || !service) return;
    fail = false;
    const created = await service.create(context, body("render-success"));
    const repeated = await service.create(context, body("render-success"));
    expect(created.status).toBe("SUCCEEDED");
    expect(repeated.id).toBe(created.id);
    expect(calls).toBe(1);
    expect(created.artifacts).toHaveLength(3);
    for (const artifact of created.artifacts) {
      const bytes = await storage.getObject({ workspaceId, objectKey: artifact.objectKey });
      expect(bytes.byteLength).toBe(artifact.byteSize);
      expect(artifact.retainedUntil).not.toBeNull();
    }
    const manifest = await service.getManifest(context, created.id);
    expect(manifest.video).toMatchObject({ objectKey: expect.any(String) });
    await expect(
      service.get({ ...context, workspaceId: otherWorkspaceId }, created.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    const edited = await service.edit(context, created.id, {
      idempotencyKey: "render-title-edit",
      retentionDays: 30,
      operation: { kind: "REPLACE_TITLE", title: "Edited" },
    });
    expect(edited).toMatchObject({ status: "SUCCEEDED", parentJobId: created.id, attempt: 1 });
    expect(edited.input.title).toBe("Edited");
    const original = await service.get(context, created.id);
    expect(original.input.title).toBe("M10 persisted render");

    let parent = edited;
    const editCases = [
      {
        kind: "REPLACE_SUBTITLE" as const,
        sceneId: "scene-one",
        captions: [{ text: "Edited caption", startMs: 0, endMs: 400 }],
      },
      {
        kind: "REPLACE_SCENE" as const,
        sceneId: "scene-one",
        scene: {
          ...created.input.scenes[0]!,
          captions: edited.input.scenes[0]!.captions,
        },
      },
      {
        kind: "REPLACE_COVER" as const,
        coverFrames: [{ assetId: visualAssetId, assetVersion: 1, timestampMs: 250 }],
      },
    ];
    for (const [index, operation] of editCases.entries()) {
      const previous = parent;
      parent = await service.edit(context, parent.id, {
        idempotencyKey: `bounded-edit-${index}`,
        retentionDays: 30,
        operation,
      });
      expect(parent).toMatchObject({
        status: "SUCCEEDED",
        parentJobId: previous.id,
        attempt: previous.attempt + 1,
      });
      expect((await service.get(context, previous.id)).status).toBe("SUCCEEDED");
    }
    const audioAssetId = randomUUID();
    await db.asset.create({
      data: {
        id: audioAssetId,
        workspaceId,
        objectKey: "fixtures/music.wav",
        mediaType: "audio/wav",
        byteSize: 8,
        checksumSha256: "c".repeat(64),
        version: 1,
        rootAssetId: audioAssetId,
        ownership: "USER_UPLOADED",
        status: "PUBLISHED",
        licenseType: "CC0-1.0",
        rightsHolder: "fixture",
      },
    });
    const audioParent = await service.create(context, {
      ...body("audio-parent"),
      input: {
        ...body("audio-parent").input,
        audio: [{ kind: "MUSIC" as const, assetId: audioAssetId, assetVersion: 1 }],
      },
    });
    const audioEdited = await service.edit(context, audioParent.id, {
      idempotencyKey: "audio-parent-edit",
      retentionDays: 30,
      operation: {
        kind: "REPLACE_AUDIO",
        index: 0,
        audio: { kind: "SFX" as const, assetId: audioAssetId, assetVersion: 1 },
      },
    });
    expect(audioEdited.input.audio.at(0)).toMatchObject({ kind: "SFX" });
  });

  it("does not create a render when the pinned M09 package has a failed scene", async () => {
    if (!db || !service) return;
    await db.sceneGeneration.update({
      where: { workspaceId_id: { workspaceId: workspaceId, id: sceneGenerationId } },
      data: { status: "FAILED_RETRYABLE" },
    });
    fail = false;
    await expect(service.create(context, body("failed-scene"))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(
      await db.renderJob.findFirst({ where: { workspaceId, idempotencyKey: "failed-scene" } }),
    ).toBeNull();
    await db.sceneGeneration.update({
      where: { workspaceId_id: { workspaceId: workspaceId, id: sceneGenerationId } },
      data: { status: "SUCCEEDED" },
    });
  });

  it("records failure without successful artifacts and retries with a fresh key and attempt", async () => {
    if (!db || !service) return;
    fail = true;
    const request = body("render-failure-parent");
    await expect(service.create(context, request)).rejects.toThrow(/no successful export/i);
    const failed = await db.renderJob.findFirstOrThrow({
      where: { workspaceId, idempotencyKey: "render-failure-parent" },
    });
    expect(failed).toMatchObject({ status: "FAILED_RETRYABLE", errorCode: "RENDER_FAILED" });
    expect(await db.renderArtifact.count({ where: { workspaceId, renderJobId: failed.id } })).toBe(
      0,
    );
    fail = false;
    await expect(service.retry(context, failed.id, request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const retried = await service.retry(context, failed.id, {
      idempotencyKey: "render-failure-retry",
      retentionDays: request.retentionDays,
      input: request.input,
    });
    expect(retried).toMatchObject({ status: "SUCCEEDED", parentJobId: failed.id, attempt: 1 });
    expect(retried.inputFingerprint).toBe(failed.inputFingerprint);
    const retainedParent = await service.get(context, failed.id);
    expect(retainedParent.status).toBe("FAILED_RETRYABLE");
    await expect(
      service.retry(context, failed.id, {
        ...request,
        input: { ...request.input, title: "Different retry input" },
      }),
    ).rejects.toThrow(/exactly replay/i);
    const again = await service.retry(context, failed.id, {
      idempotencyKey: "render-failure-retry",
      retentionDays: request.retentionDays,
      input: request.input,
    });
    expect(again.id).toBe(retried.id);
  });

  it("rejects a cross-scene cover selection before creating a render", async () => {
    if (!service) return;
    const input = body("wrong-cover").input;
    const secondSceneId = randomUUID();
    const secondAssetId = randomUUID();
    await db!.asset.create({
      data: {
        id: secondAssetId,
        workspaceId,
        objectKey: "fixtures/cover.png",
        mediaType: "image/png",
        byteSize: 8,
        checksumSha256: "a".repeat(64),
        version: 1,
        rootAssetId: secondAssetId,
        ownership: "SYSTEM_GENERATED",
        status: "PUBLISHED",
        licenseType: "CC0-1.0",
        rightsHolder: "fixture",
      },
    });
    try {
      await db!.sceneGeneration.create({
        data: {
          id: randomUUID(),
          workspaceId,
          jobId: sceneMediaJobId,
          sceneId: "scene-two",
          ordinal: 1,
          sceneVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: secondSceneId,
          resolvedPrompt: "fixture",
          sourceRefs: {},
          activeSlot: 1,
          outputs: {
            create: {
              kind: "IMAGE",
              assetId: secondAssetId,
              assetVersion: 1,
              status: "SUCCEEDED",
              providerJobId: randomUUID(),
              providerAssetId: randomUUID(),
              mediaType: "image/png",
              byteSize: 8,
              checksumSha256: "a".repeat(64),
            },
          },
        },
      });
      await expect(
        service.create(context, {
          ...body("wrong-cover"),
          input: {
            ...input,
            scenes: [
              ...input.scenes,
              { ...input.scenes[0]!, sceneId: "scene-two", assetId: secondAssetId },
            ],
            coverFrames: [{ assetId: secondAssetId, assetVersion: 1, timestampMs: 500 }],
          },
        }),
      ).rejects.toThrow(/visible at its timestamp/i);
      expect(
        await db!.renderJob.count({ where: { workspaceId, idempotencyKey: "wrong-cover" } }),
      ).toBe(0);
    } finally {
      await db!.sceneGeneration.deleteMany({
        where: { workspaceId, jobId: sceneMediaJobId, sceneId: "scene-two" },
      });
      await db!.asset.delete({ where: { workspaceId_id: { workspaceId, id: secondAssetId } } });
    }
  });

  it("requires published, rights-authorized external audio and valid storage verification", async () => {
    if (!service) return;
    const original = assetReference.getReference.bind(assetReference);
    vi.spyOn(assetReference, "getReference").mockImplementationOnce(async () => ({
      ...(await original(context, { assetId: visualAssetId, version: 1 })),
      checksumSha256: "bad",
    }));
    await expect(service.create(context, body("unlicensed-input"))).rejects.toThrow(
      /published, licensed/i,
    );
    expect(
      await db!.renderJob.count({ where: { workspaceId, idempotencyKey: "unlicensed-input" } }),
    ).toBe(0);
    vi.mocked(assetReference.getReference).mockRestore();
  });

  it("uses the package schema and active scene order to pin the composition edition", async () => {
    if (!db || !service) return;
    await db.sceneMediaJob.update({
      where: { workspaceId_id: { workspaceId, id: sceneMediaJobId } },
      data: { schemaVersion: "2.0" },
    });
    try {
      await expect(service.create(context, body("foreign-schema"))).rejects.toThrow(
        /successful M09 schema 1.0/i,
      );
    } finally {
      await db.sceneMediaJob.update({
        where: { workspaceId_id: { workspaceId, id: sceneMediaJobId } },
        data: { schemaVersion: "1.0" },
      });
    }
  });

  it("replays a create key only for identical canonical input", async () => {
    if (!service) return;
    const original = body("identity-key");
    await service.create(context, original);
    await expect(
      service.create(context, {
        ...original,
        input: { ...original.input, title: "A different package" },
      }),
    ).rejects.toThrow(/same idempotency/i);
    await expect(
      service.create(context, {
        ...original,
        input: {
          ...original.input,
          sourceMediaPackage: { ...original.input.sourceMediaPackage, jobId: randomUUID() },
        },
      }),
    ).rejects.toThrow(/same idempotency/i);
  });

  it("fails closed when the engine manifest does not describe rendered media", async () => {
    if (!service) return;
    corruptManifest = true;
    try {
      await expect(service.create(context, body("invalid-manifest"))).rejects.toThrow(
        /manifest|checksum/i,
      );
      expect(
        (
          await db!.renderJob.findUnique({
            where: {
              workspaceId_idempotencyKey: { workspaceId, idempotencyKey: "invalid-manifest" },
            },
          })
        )?.status,
      ).toBe("FAILED_FINAL");
      expect(
        await db!.renderArtifact.count({
          where: { workspaceId, job: { idempotencyKey: "invalid-manifest" } },
        }),
      ).toBe(0);
    } finally {
      corruptManifest = false;
    }
  });

  it("marks deterministic source invalidity FAILED_FINAL and bars retry", async () => {
    if (!service) return;
    invalidMedia = true;
    try {
      await expect(service.create(context, body("invalid-media"))).rejects.toThrow(/validation/i);
      const failed = await db!.renderJob.findUniqueOrThrow({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: "invalid-media" } },
      });
      expect(failed).toMatchObject({ status: "FAILED_FINAL", errorCode: "INVALID_RENDER_MEDIA" });
      invalidMedia = false;
      const request = body("invalid-media-retry");
      await expect(service.retry(context, failed.id, request)).rejects.toThrow(/retry/i);
    } finally {
      invalidMedia = false;
    }
  });

  it("denies viewer mutation before creating a job", async () => {
    if (!db || !service) return;
    await expect(
      service.create({ ...context, role: "VIEWER" }, body("viewer")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await db.renderJob.count({ where: { workspaceId, idempotencyKey: "viewer" } })).toBe(0);
  });

  it("cancels a running render and publishes no successful artifacts", async () => {
    if (!db || !service) return;
    let release = (): void => {};
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    fail = false;
    entered = new Promise<void>((resolve) => {
      engineEntered = resolve;
    });
    const rendering = service.create(context, body("render-cancel"));
    await entered;
    const queued = await db.renderJob.findUniqueOrThrow({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: "render-cancel" } },
    });
    await service.cancel(context, queued.id);
    release();
    wait = Promise.resolve();
    await expect(rendering).rejects.toThrow(/canceled/i);
    const canceled = await service.get(context, queued.id);
    expect(canceled).toMatchObject({ status: "CANCELED", errorCode: "CANCELED" });
    expect(canceled.artifacts).toHaveLength(0);
    await expect(service.getManifest(context, queued.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.cancel(context, queued.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects invalid composition requests before execution", async () => {
    if (!service) return;
    const malformed = body("bad-caption", {
      scenes: [
        { ...body("x").input.scenes[0]!, captions: [{ text: "bad", startMs: 500, endMs: 100 }] },
      ],
    });
    await expect(service.create(context, malformed)).rejects.toThrow(/caption/i);
    const parsed = parse(createRenderSchema, body("valid"));
    expect(parsed.retentionDays).toBe(30);
  });
});
