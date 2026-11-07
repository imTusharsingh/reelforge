import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { MediaValidationError, canonicalRenderFingerprint } from "@reelforge/media";
import { AssetService } from "../asset/asset.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import type { StoragePutResult } from "../asset/storage/storage.port.js";
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
  videoBody = Buffer.from("validated fixture video"),
): readonly RenderedArtifact[] {
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
    await db.renderPendingObject.deleteMany({ where: { workspaceId } });
    await db.$executeRaw`DELETE FROM render_jobs WHERE workspace_id = ${workspaceId}::uuid`;
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

  it("verifies stored video and each cover bytes before returning a manifest", async () => {
    if (!db || !service) return;
    fail = false;
    const first = await service.create(context, body("b2-video-cover-integrity"));
    const edited = await service.edit(context, first.id, {
      idempotencyKey: "b2-cover-integrity-variant",
      retentionDays: 30,
      operation: { kind: "REPLACE_TITLE", title: "Second artifact variant" },
    });
    for (const rendered of [first, edited]) {
      for (const artifact of rendered.artifacts) {
        if (artifact.kind === "MANIFEST") continue;
        const path = join(storageRoot, workspaceId, artifact.objectKey);
        const original = await readFile(path);
        try {
          await writeFile(path, Buffer.from(original.map((byte) => byte ^ 0xff)));
          await expect(service.getManifest(context, rendered.id)).rejects.toThrow(
            /Stored render object failed freshness validation|Stored render artifact failed integrity validation/,
          );
          await rm(path);
          await expect(service.getManifest(context, rendered.id)).rejects.toThrow(
            /Stored render artifact failed integrity validation/,
          );
        } finally {
          await writeFile(path, original);
        }
      }
      expect((await service.getManifest(context, rendered.id)).jobId).toBe(rendered.id);
    }
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
    expect(retainedParent).toMatchObject({
      status: "FAILED_FINAL",
      errorCode: "RETRY_SUPERSEDED",
      attempt: 1,
    });
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

  it("schedules bounded automatic retries, respects backoff and exhausts durably", async () => {
    if (!db || !service) return;
    await db.renderJob.updateMany({
      where: { workspaceId, status: "FAILED_RETRYABLE" },
      data: {
        status: "FAILED_FINAL",
        errorCode: "RETRY_EXHAUSTED",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const request = body(`b4-backoff-${randomUUID()}`);
    fail = true;
    try {
      await expect(service.create(context, request)).rejects.toThrow(/no successful export/);
    } finally {
      fail = false;
    }
    const stored = await db.renderJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey: request.idempotencyKey },
      },
    });
    let now = Date.now();
    const alwaysFails: CompositionEnginePort = {
      execute: async () => {
        throw new Error("storage unavailable for committed recovery test");
      },
    };
    const worker = new CompositionService(db as Database, alwaysFails, storage, assetReference, {
      now: (): Date => new Date(now),
    });
    for (const [attempt, delay] of [250, 500, 1000].entries()) {
      expect(await worker.runClaim(stored.id)).toBeNull();
      now += delay;
      expect((await worker.runScheduled(10, stored.id)).claimed).toBe(1);
      const failed = await db.renderJob.findUniqueOrThrow({ where: { id: stored.id } });
      expect(failed.scheduledAttempts).toBe(attempt + 1);
      expect(failed.attempt).toBe(attempt + 1);
      if (attempt < 2) {
        expect(failed.status).toBe("FAILED_RETRYABLE");
        expect(failed.nextAttemptAt.getTime()).toBe(now + [250, 500, 1000][attempt + 1]!);
      } else {
        expect(failed).toMatchObject({ status: "FAILED_FINAL", errorCode: "RETRY_EXHAUSTED" });
        expect(failed.attempt).toBe(3);
      }
    }
    expect((await worker.runScheduled(10, stored.id)).claimed).toBe(0);
    expect(await worker.runClaim(stored.id)).toBeNull();
    expect(await db.renderJob.findUniqueOrThrow({ where: { id: stored.id } })).toMatchObject({
      status: "FAILED_FINAL",
      errorCode: "RETRY_EXHAUSTED",
      attempt: 3,
    });
  });

  it("terminalizes an exhausted stale running claim instead of stranding it", async () => {
    if (!db || !service) return;
    const key = `b4-exhausted-recovery-${randomUUID()}`;
    const request = body(key);
    const created = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "RUNNING",
        attempt: 3,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
        input: request.input,
        inputFingerprint: "f".repeat(64),
        createdByUserId: userId,
      },
    });
    const alwaysFails: CompositionEnginePort = {
      execute: async () => {
        throw new Error("should not execute an exhausted claim");
      },
    };
    const worker = new CompositionService(db as Database, alwaysFails, storage, assetReference);
    expect(await worker.runClaim(created.id)).toBeNull();
    expect(await db.renderJob.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: "FAILED_FINAL",
      errorCode: "RETRY_EXHAUSTED",
      leaseToken: null,
      leaseExpiresAt: null,
      attempt: 3,
    });
  });

  it("rejects retry children once the retry limit is exhausted", async () => {
    if (!db || !service) return;
    const key = `b4-retry-limit-${randomUUID()}`;
    const request = body(key);
    const exhausted = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "CANCELED",
        attempt: 3,
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    await expect(
      service.retry(context, exhausted.id, {
        idempotencyKey: `${key}-retry`,
        retentionDays: request.retentionDays,
        input: request.input,
      }),
    ).rejects.toThrow(/retry limit/i);
  });

  it("consumes the shared retry budget under concurrent fresh-key retries", async () => {
    if (!db || !service) return;
    const key = `b4-concurrent-retry-${randomUUID()}`;
    const request = body(key);
    fail = true;
    try {
      await expect(service.create(context, request)).rejects.toThrow(/no successful export/);
    } finally {
      fail = false;
    }
    const parent = await db.renderJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey: request.idempotencyKey },
      },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        service.retry(context, parent.id, {
          idempotencyKey: `${key}-retry-${index}`,
          retentionDays: request.retentionDays,
          input: request.input,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const children = await db.renderJob.findMany({ where: { parentJobId: parent.id } });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ attempt: 1, status: "SUCCEEDED" });
    // The parent is superseded, so automatic recovery cannot execute it too.
    const worker = new CompositionService(db as Database, engine, storage, assetReference);
    expect(await worker.runClaim(parent.id)).toBeNull();
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe(
      "FAILED_FINAL",
    );
  });

  it("fences a canceled parent to one child, preserves its cancellation, and replays the same key", async () => {
    if (!db || !service) return;
    fail = false;
    wait = Promise.resolve();
    const key = `b4-canceled-fence-${randomUUID()}`;
    const request = body(key);
    const canceledAt = new Date("2026-01-01T00:00:00.000Z");
    const parent = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "CANCELED",
        attempt: 0,
        cancelRequestedAt: canceledAt,
        errorCode: "CANCELED",
        errorMessage: "Canceled during execution",
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    const retryKey = `${key}-retry`;
    const first = await service.retry(context, parent.id, {
      ...request,
      idempotencyKey: retryKey,
    });
    expect(first).toMatchObject({ status: "SUCCEEDED", parentJobId: parent.id, attempt: 1 });
    const replay = await service.retry(context, parent.id, {
      ...request,
      idempotencyKey: retryKey,
    });
    expect(replay.id).toBe(first.id);
    await db.renderJob.update({
      where: { id: first.id },
      data: { status: "FAILED_RETRYABLE", attempt: 1 },
    });
    const descendant = await service.retry(context, first.id, {
      ...request,
      idempotencyKey: `${key}-descendant`,
    });
    expect(descendant).toMatchObject({
      status: "SUCCEEDED",
      parentJobId: first.id,
      attempt: 2,
    });
    expect(await db.renderJob.count({ where: { parentJobId: parent.id } })).toBe(1);
    expect(await db.renderJob.count({ where: { parentJobId: first.id } })).toBe(1);
    await expect(
      service.retry(context, first.id, {
        ...request,
        idempotencyKey: `${key}-other-descendant`,
      }),
    ).rejects.toThrow(/already been retried/i);
    const storedParent = await db.renderJob.findUniqueOrThrow({ where: { id: parent.id } });
    expect(storedParent).toMatchObject({
      status: "CANCELED",
      errorCode: "CANCELED",
      errorMessage: "Canceled during execution",
      attempt: 1,
    });
    expect(storedParent.cancelRequestedAt?.toISOString()).toBe(canceledAt.toISOString());
    expect(storedParent.retrySupersededAt).not.toBeNull();
    expect(await db.renderJob.count({ where: { parentJobId: parent.id } })).toBe(1);
    await expect(
      service.retry(context, parent.id, {
        ...request,
        idempotencyKey: `${key}-other`,
      }),
    ).rejects.toThrow(/already been retried/i);
    expect(await db.renderJob.count({ where: { parentJobId: parent.id } })).toBe(1);
    // Automatic claims honor the same fence and cannot consume another attempt.
    const worker = new CompositionService(db as Database, engine, storage, assetReference);
    expect(await worker.runClaim(parent.id)).toBeNull();
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: parent.id } })).attempt).toBe(1);
  });

  it("creates one child for concurrent fresh-key retries of a canceled parent", async () => {
    if (!db || !service) return;
    fail = false;
    wait = Promise.resolve();
    const key = `b4-canceled-concurrent-${randomUUID()}`;
    const request = body(key);
    const canceledAt = new Date("2026-02-01T00:00:00.000Z");
    const parent = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "CANCELED",
        attempt: 0,
        cancelRequestedAt: canceledAt,
        errorCode: "CANCELED",
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        service.retry(context, parent.id, {
          ...request,
          idempotencyKey: `${key}-retry-${index}`,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const children = await db.renderJob.findMany({ where: { parentJobId: parent.id } });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ attempt: 1, status: "SUCCEEDED" });
    const storedParent = await db.renderJob.findUniqueOrThrow({ where: { id: parent.id } });
    expect(storedParent).toMatchObject({
      status: "CANCELED",
      errorCode: "CANCELED",
      attempt: 1,
    });
    expect(storedParent.cancelRequestedAt?.toISOString()).toBe(canceledAt.toISOString());
  });

  it("serializes an automatic claim against a manual retry of the same family member", async () => {
    if (!db || !service) return;
    const key = `b4-manual-auto-overlap-${randomUUID()}`;
    const request = body(key);
    const parent = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-parent`,
        status: "FAILED_RETRYABLE",
        attempt: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    let executions = 0;
    const countedEngine: CompositionEnginePort = {
      execute: async (_context, id, input) => {
        executions++;
        return validArtifacts(input, id);
      },
    };
    const manual = new CompositionService(db as Database, countedEngine, storage, assetReference);
    const worker = new CompositionService(db as Database, countedEngine, storage, assetReference);
    const outcomes = await Promise.allSettled([
      manual.retry(context, parent.id, {
        ...request,
        idempotencyKey: `${key}-manual`,
      }),
      worker.runClaim(parent.id),
    ]);
    const storedParent = await db.renderJob.findUniqueOrThrow({ where: { id: parent.id } });
    const children = await db.renderJob.findMany({ where: { parentJobId: parent.id } });
    expect(executions).toBe(1);
    expect(children.length).toBeLessThanOrEqual(1);
    if (children.length === 1) {
      expect(storedParent).toMatchObject({
        status: "FAILED_FINAL",
        errorCode: "RETRY_SUPERSEDED",
      });
      expect(storedParent.retrySupersededAt).not.toBeNull();
      expect(children[0]).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
      expect(outcomes[0]?.status).toBe("fulfilled");
    } else {
      expect(storedParent.status).toBe("SUCCEEDED");
      expect(outcomes[0]?.status).toBe("rejected");
      expect(outcomes[1]?.status).toBe("fulfilled");
    }
  });

  it("recovers a stale running job left during execution and publishes exactly once", async () => {
    if (!db || !service) return;
    fail = false;
    const key = `b4-running-recovery-${randomUUID()}`;
    const created = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        input: body(key).input,
        inputFingerprint: "c".repeat(64),
        createdByUserId: userId,
      },
    });
    const stale = await db.renderJob.update({
      where: { id: created.id },
      data: {
        status: "RUNNING",
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    expect(await db.renderArtifact.count({ where: { renderJobId: created.id } })).toBe(0);
    const recoveryEngine: CompositionEnginePort = {
      execute: async (_context, id, input) => validArtifacts(input, id),
    };
    const restarted = new CompositionService(
      db as Database,
      recoveryEngine,
      storage,
      assetReference,
    );
    expect((await restarted.runClaim(stale.id))?.status).toBe("SUCCEEDED");
    expect(await restarted.runClaim(stale.id)).toBeNull();
    const done = await restarted.get(context, stale.id);
    expect(done).toMatchObject({ status: "SUCCEEDED" });
    expect(done.artifacts).toHaveLength(3);
    expect((await restarted.getManifest(context, stale.id)).jobId).toBe(stale.id);
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: stale.id } })).attempt).toBe(1);
  });

  it("recovers a queued child render through the same durable scheduler", async () => {
    if (!db || !service) return;
    fail = false;
    const parent = await service.create(context, body(`b4-child-parent-${randomUUID()}`));
    const key = `b4-queued-child-${randomUUID()}`;
    const request = body(key);
    const child = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        parentJobId: parent.id,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "QUEUED",
        attempt: parent.attempt + 1,
        input: request.input,
        inputFingerprint: "2".repeat(64),
        createdByUserId: userId,
      },
    });
    const recoveryEngine: CompositionEnginePort = {
      execute: async (_context, id, input) => validArtifacts(input, id),
    };
    const worker = new CompositionService(db as Database, recoveryEngine, storage, assetReference);
    expect((await worker.runScheduled(10, child.id)).claimed).toBe(1);
    expect(await worker.get(context, child.id)).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
  });

  it("allows an exact retry after cancellation without reusing terminal state", async () => {
    if (!db || !service) return;
    const request = body(`b1-canceled-retry-${randomUUID()}`);
    let release = (): void => {};
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    entered = new Promise<void>((resolve) => {
      engineEntered = resolve;
    });
    fail = false;
    const first = service.create(context, request);
    await entered;
    const job = await db.renderJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey: request.idempotencyKey },
      },
    });
    await service.cancel(context, job.id);
    release();
    wait = Promise.resolve();
    await expect(first).rejects.toThrow(/canceled/i);
    expect((await service.get(context, job.id)).status).toBe("CANCELED");
    const retried = await service.retry(context, job.id, {
      ...request,
      idempotencyKey: `b1-canceled-retry-child-${randomUUID()}`,
    });
    expect(retried).toMatchObject({ status: "SUCCEEDED", parentJobId: job.id, attempt: 1 });
  });

  it("cancels after a durable claim but before controller registration and cannot render", async () => {
    if (!db || !service) return;
    fail = false;
    let releaseRegistration = (): void => {};
    const registration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let claimedJobId = "";
    let reachedClaim = (): void => {};
    const claimed = new Promise<void>((resolve) => {
      reachedClaim = resolve;
    });
    let engineCalls = 0;
    class RegisterRaceCompositionService extends CompositionService {
      protected override async afterClaim(jobId: string): Promise<void> {
        claimedJobId = jobId;
        reachedClaim();
        await registration;
      }
    }
    const racing = new RegisterRaceCompositionService(
      db as Database,
      {
        execute: async (_context, id, input): Promise<readonly RenderedArtifact[]> => {
          engineCalls++;
          return validArtifacts(input, id);
        },
      },
      storage,
      assetReference,
    );
    const rendering = racing.create(context, body(`b1-registration-${randomUUID()}`));
    await claimed;
    await service.cancel(context, claimedJobId);
    releaseRegistration();
    await expect(rendering).rejects.toThrow(/canceled/i);
    expect((await service.get(context, claimedJobId)).status).toBe("CANCELED");
    expect(engineCalls).toBe(0);
  });

  it("preserves cross-instance cancellation over transient and permanent execution errors", async () => {
    if (!db || !service) return;
    fail = false;
    const cases: Array<readonly [string, Error]> = [
      ["transient", new Error("transient renderer failure")],
      ["permanent", new MediaValidationError("Pinned source media failed technical validation")],
    ];
    for (const [label, engineError] of cases) {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = (): void => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const request = body(`b1-cross-instance-${label}-${randomUUID()}`);
      const job = await db.renderJob.create({
        data: {
          workspaceId,
          sceneMediaJobId,
          idempotencyKey: `${request.idempotencyKey}-${randomUUID()}`,
          status: "QUEUED",
          input: request.input,
          inputFingerprint: canonicalRenderFingerprint(request.input),
          createdByUserId: userId,
        },
      });
      const cancellingExecutor = new CompositionService(
        db as Database,
        {
          execute: async (): Promise<readonly RenderedArtifact[]> => {
            entered();
            await gate;
            throw engineError;
          },
        },
        storage,
        assetReference,
      );
      const running = cancellingExecutor.runClaim(job.id);
      await started;
      // A different service instance requests cancellation while this executor
      // is running, so the executor does not own the in-memory abort controller.
      await service.cancel(context, job.id);
      release();
      await running;
      expect(await db.renderJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: "CANCELED",
        errorCode: "CANCELED",
        leaseToken: null,
        leaseExpiresAt: null,
      });
    }
  });

  it("two due worker claims execute and publish only once", async () => {
    if (!db || !service) return;
    const key = `b1-concurrent-claims-${randomUUID()}`;
    const request = body(key);
    const created = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "QUEUED",
        input: request.input,
        inputFingerprint: "e".repeat(64),
        createdByUserId: userId,
      },
    });
    const committedEngine: CompositionEnginePort = {
      execute: async (_context, id, input) => validArtifacts(input, id),
    };
    const one = new CompositionService(db as Database, committedEngine, storage, assetReference);
    const two = new CompositionService(db as Database, committedEngine, storage, assetReference);
    await Promise.all([one.runScheduled(10, created.id), two.runScheduled(10, created.id)]);
    const result = await one.get(context, created.id);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.artifacts).toHaveLength(3);
    expect(await db.renderJob.count({ where: { workspaceId, id: created.id } })).toBe(1);
    expect(await db.renderArtifact.count({ where: { renderJobId: created.id } })).toBe(3);
    expect(await db.renderJob.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      attempt: 1,
      status: "SUCCEEDED",
    });
  });

  it("a restarted service actually completes an abandoned running lease once and publishes output", async () => {
    if (!db || !service) return;
    const recoveryEngine: CompositionEnginePort = {
      execute: async (_context, id, input) => validArtifacts(input, id),
    };
    fail = false;
    const key = `b4-recovery-${randomUUID()}`;
    const request = body(key);
    const aborted = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "QUEUED",
        input: request.input,
        inputFingerprint: "d".repeat(64),
        createdByUserId: userId,
      },
    });
    await db.renderJob.update({
      where: { id: aborted.id },
      data: {
        status: "RUNNING",
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    const worker = new CompositionService(db as Database, recoveryEngine, storage, assetReference);
    const recovered = await worker.runClaim(aborted.id);
    expect(recovered).toMatchObject({ status: "SUCCEEDED", leaseExpiresAt: null });
    expect(await worker.runClaim(aborted.id)).toBeNull();
    expect((await worker.getManifest(context, aborted.id)).jobId).toBe(aborted.id);
  });

  it("prevents a superseded live executor from overwriting recovered success", async () => {
    if (!db || !service) return;
    fail = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const staleBody = Buffer.from("stale executor video");
    const staleExecutor = new CompositionService(
      db as Database,
      {
        execute: async (_context, id, input): Promise<readonly RenderedArtifact[]> => {
          entered();
          await gate;
          return validArtifacts(input, id, staleBody);
        },
      },
      storage,
      assetReference,
    );
    const request = body(`b4-live-stale-${randomUUID()}`);
    const rendering = staleExecutor.create(context, request);
    await started;
    const job = await db.renderJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey: request.idempotencyKey },
      },
    });
    await db.renderJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const recovered = await new CompositionService(
      db as Database,
      {
        execute: async (_context, id, input): Promise<readonly RenderedArtifact[]> =>
          validArtifacts(input, id),
      },
      storage,
      assetReference,
    ).runClaim(job.id);
    expect(recovered).toMatchObject({ status: "SUCCEEDED", attempt: 1 });
    release();
    await expect(rendering).resolves.toMatchObject({ status: "SUCCEEDED" });
    const final = await service.get(context, job.id);
    const videoArtifact = final.artifacts.find((artifact) => artifact.kind === "VIDEO")!;
    const stored = await storage.getObject({ workspaceId, objectKey: videoArtifact.objectKey });
    expect(stored.equals(staleBody)).toBe(false);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(videoArtifact.checksumSha256);
    expect((await service.getManifest(context, job.id)).jobId).toBe(job.id);
  });

  it("records every planned key before upload and cleans a write-then-throw orphan", async () => {
    if (!db || !service) return;
    fail = false;
    wait = Promise.resolve();
    const request = body(`b4-write-then-throw-${randomUUID()}`);
    const originalPut = storage.putObject.bind(storage);
    const originalDelete = storage.deleteObject.bind(storage);
    let plannedAtFirstUpload = -1;
    let thrownKey = "";
    let deleteFailed = false;
    storage.putObject = async (input): Promise<StoragePutResult> => {
      if (plannedAtFirstUpload < 0) {
        const job = await db!.renderJob.findUniqueOrThrow({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
        plannedAtFirstUpload = await db!.renderPendingObject.count({
          where: { workspaceId, renderJobId: job.id },
        });
      }
      if (input.objectKey.endsWith("final.mp4")) {
        thrownKey = input.objectKey;
        await originalPut(input);
        throw new Error("upload wrote bytes but the response was lost");
      }
      return originalPut(input);
    };
    storage.deleteObject = async (input): Promise<void> => {
      if (input.objectKey === thrownKey && !deleteFailed) {
        deleteFailed = true;
        throw new Error("storage deletion failed during upload cleanup");
      }
      return originalDelete(input);
    };
    try {
      await expect(service.create(context, request)).rejects.toThrow(
        /no successful export|response was lost/i,
      );
    } finally {
      storage.putObject = originalPut;
      storage.deleteObject = originalDelete;
    }
    const job = await db.renderJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    expect(plannedAtFirstUpload).toBe(3);
    expect(thrownKey).not.toBe("");
    expect(deleteFailed).toBe(true);
    const rows = await db.renderPendingObject.findMany({ where: { renderJobId: job.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectKey).toBe(thrownKey);
    // The write completed despite its error and the immediate delete failed.
    // The ledger row must retain it for the later cleanup pass.
    await expect(storage.getObject({ workspaceId, objectKey: thrownKey })).resolves.toBeDefined();
    const early = new CompositionService(db as Database, engine, storage, assetReference);
    await early.cleanupPendingObjects();
    expect(await db.renderPendingObject.count({ where: { renderJobId: job.id } })).toBe(1);
    const advanced = new CompositionService(db as Database, engine, storage, assetReference, {
      now: (): Date => new Date(Date.now() + 21 * 60 * 1000),
    });
    await advanced.cleanupPendingObjects();
    expect(await db.renderPendingObject.count({ where: { renderJobId: job.id } })).toBe(0);
    await expect(storage.getObject({ workspaceId, objectKey: thrownKey })).rejects.toThrow();
  });

  it("retains a cleanup record until a late upload can no longer race the sweep", async () => {
    if (!db || !service) return;
    fail = false;
    wait = Promise.resolve();
    const request = body(`b4-late-upload-${randomUUID()}`);
    const originalPut = storage.putObject.bind(storage);
    // Stay ahead of the database clock so the fresh job is immediately claimable.
    let clock = Date.now() + 60_000;
    let lateKey = "";
    let releaseLate = (): void => {};
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let started = (): void => {};
    const startedWriting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let lateWritten = (): void => {};
    const lateWriteLanded = new Promise<void>((resolve) => {
      lateWritten = resolve;
    });
    storage.putObject = async (input): Promise<StoragePutResult> => {
      if (input.objectKey.endsWith("final.mp4")) {
        lateKey = input.objectKey;
        started();
        await lateGate;
        await originalPut(input);
        lateWritten();
        throw new Error("late write finished after the upload deadline");
      }
      return originalPut(input);
    };
    const bounded = new CompositionService(db as Database, engine, storage, assetReference, {
      now: (): Date => new Date(clock),
      uploadDeadlineMs: 30,
      pendingObjectGraceMs: 50,
    });
    try {
      const rendering = bounded.create(context, request);
      await startedWriting;
      await expect(rendering).rejects.toThrow(/deadline|no successful export/i);
      const job = await db.renderJob.findUniqueOrThrow({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      const row = await db.renderPendingObject.findFirst({
        where: { renderJobId: job.id, objectKey: lateKey },
      });
      expect(row).not.toBeNull();
      // The grace window has not elapsed, so the sweep must keep the record.
      expect(await bounded.cleanupPendingObjects()).toBe(0);
      expect(
        await db.renderPendingObject.count({
          where: { renderJobId: job.id, objectKey: lateKey },
        }),
      ).toBe(1);
      // The old writer now completes after the executor already cleaned up.
      releaseLate();
      await lateWriteLanded;
      await expect(storage.getObject({ workspaceId, objectKey: lateKey })).resolves.toBeDefined();
      // Only after the upload deadline plus grace is the late write impossible.
      clock += 30 + 50 + 1;
      expect(await bounded.cleanupPendingObjects()).toBe(1);
      await expect(storage.getObject({ workspaceId, objectKey: lateKey })).rejects.toThrow();
      expect(
        await db.renderPendingObject.count({
          where: { renderJobId: job.id, objectKey: lateKey },
        }),
      ).toBe(0);
    } finally {
      releaseLate();
      storage.putObject = originalPut;
    }
  });

  it("keeps a pending cleanup record across a storage deletion outage", async () => {
    if (!db || !service) return;
    const key = `b4-cleanup-outage-${randomUUID()}`;
    const request = body(key);
    const job = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: key,
        status: "FAILED_RETRYABLE",
        attempt: 1,
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    const objectKey = `render/${job.id}/orphan/final.mp4`;
    await storage.putObject({
      workspaceId,
      objectKey,
      body: Buffer.from("orphaned render bytes"),
      contentType: "video/mp4",
    });
    await db.renderPendingObject.create({
      data: {
        workspaceId,
        objectKey,
        renderJobId: job.id,
        leaseToken: randomUUID(),
        createdAt: new Date(Date.now() - 25 * 60 * 1000),
      },
    });
    const originalDelete = storage.deleteObject.bind(storage);
    storage.deleteObject = async (): Promise<void> => {
      throw new Error("simulated storage deletion outage");
    };
    try {
      expect(await service.cleanupPendingObjects()).toBe(0);
      expect(await db.renderPendingObject.count({ where: { workspaceId, objectKey } })).toBe(1);
      await expect(storage.getObject({ workspaceId, objectKey })).resolves.toBeDefined();
    } finally {
      storage.deleteObject = originalDelete;
    }
    expect(await service.cleanupPendingObjects()).toBe(1);
    expect(await db.renderPendingObject.count({ where: { workspaceId, objectKey } })).toBe(0);
    await expect(storage.getObject({ workspaceId, objectKey })).rejects.toThrow();
  });

  it("never deletes a renewed live claim while sweeping pending objects", async () => {
    if (!db || !service) return;
    const key = `b4-live-cleanup-${randomUUID()}`;
    const leaseToken = randomUUID();
    const request = body(key);
    const live = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "RUNNING",
        attempt: 1,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    const objectKey = `render/${live.id}/${leaseToken}/final.mp4`;
    await storage.putObject({
      workspaceId,
      objectKey,
      body: Buffer.from("live claim bytes"),
      contentType: "video/mp4",
    });
    await db.renderPendingObject.create({
      data: {
        workspaceId,
        objectKey,
        renderJobId: live.id,
        leaseToken,
        createdAt: new Date(Date.now() - 25 * 60 * 1000),
      },
    });
    await service.cleanupPendingObjects();
    expect(await db.renderPendingObject.count({ where: { workspaceId, objectKey } })).toBe(1);
    await expect(storage.getObject({ workspaceId, objectKey })).resolves.toBeDefined();
    await db.renderJob.update({
      where: { id: live.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await service.cleanupPendingObjects();
    expect(await db.renderPendingObject.count({ where: { workspaceId, objectKey } })).toBe(0);
    await expect(storage.getObject({ workspaceId, objectKey })).rejects.toThrow();
  });

  it("never deletes a published artifact referenced by a stale cleanup record", async () => {
    if (!db || !service) return;
    fail = false;
    wait = Promise.resolve();
    const created = await service.create(context, body(`b4-published-cleanup-${randomUUID()}`));
    const video = created.artifacts.find((artifact) => artifact.kind === "VIDEO")!;
    await db.renderPendingObject.create({
      data: {
        workspaceId,
        objectKey: video.objectKey,
        renderJobId: created.id,
        leaseToken: randomUUID(),
        createdAt: new Date(Date.now() - 25 * 60 * 1000),
      },
    });
    await service.cleanupPendingObjects();
    expect(
      await db.renderPendingObject.count({ where: { workspaceId, objectKey: video.objectKey } }),
    ).toBe(0);
    await expect(
      storage.getObject({ workspaceId, objectKey: video.objectKey }),
    ).resolves.toBeDefined();
    expect((await service.get(context, created.id)).status).toBe("SUCCEEDED");
  });

  it("restricts render job deletion while a pending cleanup record exists", async () => {
    if (!db || !service) return;
    const key = `b4-delete-safety-${randomUUID()}`;
    const request = body(key);
    const job = await db.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `${key}-${randomUUID()}`,
        status: "FAILED_RETRYABLE",
        attempt: 1,
        input: request.input,
        inputFingerprint: canonicalRenderFingerprint(request.input),
        createdByUserId: userId,
      },
    });
    const objectKey = `render/${job.id}/pending/orphan.mp4`;
    await db.renderPendingObject.create({
      data: {
        workspaceId,
        objectKey,
        renderJobId: job.id,
        leaseToken: randomUUID(),
        createdAt: new Date(Date.now() - 25 * 60 * 1000),
      },
    });
    await expect(db.renderJob.delete({ where: { id: job.id } })).rejects.toThrow();
    await service.cleanupPendingObjects();
    expect(await db.renderPendingObject.count({ where: { workspaceId, objectKey } })).toBe(0);
    await db.renderJob.delete({ where: { id: job.id } });
  });

  it("deletes expired video covers and manifest bytes then denies subsequent access", async () => {
    if (!db || !service) return;
    fail = false;
    const created = await service.create(context, body("b4-retention"));
    expect(created.expiredAt).toBeNull();
    const past = new Date(Date.now() - 1000);
    await db.renderArtifact.updateMany({
      where: { renderJobId: created.id },
      data: { retainedUntil: past },
    });
    const removed = await service.expireRetainedOutputs();
    expect(removed).toBe(3);
    for (const artifact of created.artifacts)
      await expect(
        storage.getObject({ workspaceId, objectKey: artifact.objectKey }),
      ).rejects.toThrow();
    expect(
      (await db.renderJob.findUniqueOrThrow({ where: { id: created.id } })).expiredAt,
    ).not.toBeNull();
    await expect(service.get(context, created.id)).rejects.toThrow(/expired/);
  });

  it("retains artifacts and denies access when retention deletion fails", async () => {
    if (!db || !service) return;
    fail = false;
    const created = await service.create(context, body(`b4-retention-failure-${randomUUID()}`));
    await db.renderArtifact.updateMany({
      where: { renderJobId: created.id },
      data: { retainedUntil: new Date(Date.now() - 1000) },
    });
    const originalDelete = storage.deleteObject.bind(storage);
    let injected = true;
    const calls: string[] = [];
    storage.deleteObject = async (input): Promise<void> => {
      calls.push(input.objectKey);
      // Fail after the first object so the retry covers already-deleted bytes.
      if (injected && calls.length === 2) throw new Error("simulated storage outage");
      return originalDelete(input);
    };
    try {
      await expect(service.expireRetainedOutputs()).rejects.toThrow(/retried/);
      const pending = await db.renderJob.findUniqueOrThrow({ where: { id: created.id } });
      expect(pending.expiredAt).toBeNull();
      expect(pending.leaseToken).toBeNull();
      expect(calls).toHaveLength(2);
      await expect(storage.getObject({ workspaceId, objectKey: calls[0]! })).rejects.toThrow();
      await expect(service.get(context, created.id)).rejects.toThrow(/expired/);
      injected = false;
      expect(await service.expireRetainedOutputs()).toBe(3);
      for (const artifact of created.artifacts)
        await expect(
          storage.getObject({ workspaceId, objectKey: artifact.objectKey }),
        ).rejects.toThrow();
      await expect(service.getManifest(context, created.id)).rejects.toThrow(/expired/);
    } finally {
      storage.deleteObject = originalDelete;
    }
  });

  it("reclaims an expired retention lease after a crash mid-deletion", async () => {
    if (!db || !service) return;
    fail = false;
    const created = await service.create(context, body(`b4-retention-crash-${randomUUID()}`));
    await db.renderArtifact.updateMany({
      where: { renderJobId: created.id },
      data: { retainedUntil: new Date(Date.now() - 1000) },
    });
    // Simulate a process dying after one object was removed but before the
    // expiry marker and lease were cleared.
    await storage.deleteObject({
      workspaceId,
      objectKey: created.artifacts[0]!.objectKey,
    });
    await db.renderJob.update({
      where: { id: created.id },
      data: {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(await service.expireRetainedOutputs()).toBe(3);
    const expired = await db.renderJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(expired.expiredAt).not.toBeNull();
    expect(expired.leaseToken).toBeNull();
    for (const artifact of created.artifacts)
      await expect(
        storage.getObject({ workspaceId, objectKey: artifact.objectKey }),
      ).rejects.toThrow();
    await expect(service.get(context, created.id)).rejects.toThrow(/expired/);
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

  it("terminalizes cancel-before-claim and does not allow its old executor to claim", async () => {
    const job = await db!.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `b1-cancel-before-claim-${randomUUID()}`,
        status: "QUEUED",
        input: body("b1-cancel-before-claim").input,
        inputFingerprint: "a".repeat(64),
        createdByUserId: userId,
      },
    });
    const canceled = await service!.cancel(context, job.id);
    expect(canceled.status).toBe("CANCELED");
    expect(canceled.cancelRequestedAt).not.toBeNull();
    expect(canceled.errorCode).toBe("CANCELED");
    expect(await service!.claimForExecution(job.id)).toBe(false);
  });

  it("allows only one worker and recovers an abandoned claim after lease expiry", async () => {
    const job = await db!.renderJob.create({
      data: {
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: "b1-restart-after-abandoned-claim",
        status: "QUEUED",
        input: body("b1-restart-after-abandoned-claim").input,
        inputFingerprint: "b".repeat(64),
        createdByUserId: userId,
      },
    });
    const otherWorker = new CompositionService(db! as Database, engine, storage, assetReference);
    expect(await service!.claimForExecution(job.id)).toBe(true);
    expect(await otherWorker.claimForExecution(job.id)).toBe(false);
    await db!.renderJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    expect(await otherWorker.claimForExecution(job.id)).toBe(true);
    expect(await service!.claimForExecution(job.id)).toBe(false);
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
