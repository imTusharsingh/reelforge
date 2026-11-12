import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createDatabaseClient } from "@reelforge/database";
import { COMPOSITION_ENGINE } from "../composition/composition.types.js";
import { CompositionModule } from "../composition/composition.module.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { sha256Hex } from "./storage/checksum.js";
import { StorageObjectNotFoundError, STORAGE_PORT } from "./storage/storage.port.js";
import type { StoragePort, StoragePutInput, StoragePutResult } from "./storage/storage.port.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const ownerId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const foreignOwnerId = randomUUID();

const assetRootId = randomUUID();
const assetV2Id = randomUUID();
const foreignAssetId = randomUUID();
const corruptAssetId = randomUUID();
const missingAssetId = randomUUID();

const sceneMediaJobId = randomUUID();
const sceneGenerationId = randomUUID();
const scriptId = randomUUID();
const channelId = randomUUID();
const configId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
const promptId = randomUUID();
const ideaId = randomUUID();
const approvalId = randomUUID();

const foreignSceneMediaJobId = randomUUID();
const foreignSceneGenerationId = randomUUID();
const foreignScriptId = randomUUID();
const foreignChannelId = randomUUID();
const foreignConfigId = randomUUID();
const foreignTemplateId = randomUUID();
const foreignTemplateVersionId = randomUUID();
const foreignPromptId = randomUUID();
const foreignIdeaId = randomUUID();
const foreignApprovalId = randomUUID();

const jobId = randomUUID();
const failedJobId = randomUUID();
const expiredJobId = randomUUID();
const expiredArtifactJobId = randomUUID();
const corruptArtifactJobId = randomUUID();
const missingArtifactJobId = randomUUID();
const foreignJobId = randomUUID();

const videoAssetId = randomUUID();
const expiredArtifactAssetId = randomUUID();
const corruptArtifactAssetId = randomUUID();
const missingArtifactAssetId = randomUUID();
const foreignVideoAssetId = randomUUID();
const videoArtifactId = randomUUID();
const expiredArtifactId = randomUUID();
const corruptArtifactId = randomUUID();
const missingArtifactId = randomUUID();
const foreignArtifactId = randomUUID();

const assetV1Body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const assetV2Body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
const foreignAssetBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]);
const corruptAssetBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04]);
const videoBody = Buffer.from("verified render artifact video bytes");
const expiredVideoBody = Buffer.from("expired render artifact video bytes");
const corruptVideoBody = Buffer.from("corrupt render artifact video bytes");
const missingVideoBody = Buffer.from("missing render artifact video bytes");
const foreignVideoBody = Buffer.from("foreign render artifact video bytes");

const assetV1Key = `assets/${assetRootId}/v1/one.png`;
const assetV2Key = `assets/${assetRootId}/v2/two.png`;
const foreignAssetKey = `assets/${foreignAssetId}/v1/foreign.png`;
const corruptAssetKey = `assets/${corruptAssetId}/v1/corrupt.png`;
const missingAssetKey = `assets/${missingAssetId}/v1/missing.png`;
const videoKey = `render/${jobId}/lease/final.mp4`;
const expiredVideoKey = `render/${expiredArtifactJobId}/lease/final.mp4`;
const corruptVideoKey = `render/${corruptArtifactJobId}/lease/final.mp4`;
const missingVideoKey = `render/${missingArtifactJobId}/lease/final.mp4`;
const foreignVideoKey = `render/${foreignJobId}/lease/final.mp4`;

class MemoryStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    this.objects.set(`${input.workspaceId}/${input.objectKey}`, Buffer.from(input.body));
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer> {
    const body = this.objects.get(`${input.workspaceId}/${input.objectKey}`);
    if (!body) throw new StorageObjectNotFoundError();
    return body;
  }

  public async deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void> {
    this.objects.delete(`${input.workspaceId}/${input.objectKey}`);
  }
}

function get(
  server: unknown,
  url: string,
  token?: string,
  headers: Readonly<Record<string, string>> = {},
): request.Test {
  let call = request(server as never)
    .get(url)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  if (token !== undefined) call = call.set("Authorization", `Bearer ${token}`);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call;
}

suite("authorized media delivery HTTP contract", () => {
  const db = databaseUrl ? createDatabaseClient(databaseUrl) : undefined;
  const storage = new MemoryStorage();
  let app: INestApplication | undefined;
  let ownerToken = "";
  let viewerToken = "";
  let outsiderToken = "";
  let foreignOwnerToken = "";

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, viewerId, outsiderId, foreignOwnerId].map((id) => ({
        id,
        email: `${id}@m59-http.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m59-http" },
        { id: foreignWorkspaceId, name: "m59-foreign" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: foreignWorkspaceId, userId: foreignOwnerId, role: "OWNER" },
      ],
    });
    const sessions: string[] = [];
    for (const id of [ownerId, viewerId, outsiderId, foreignOwnerId]) {
      const token = randomUUID();
      sessions.push(token);
      await db.session.create({
        data: {
          userId: id,
          tokenHash: hashSessionToken(token),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    [ownerToken, viewerToken, outsiderToken, foreignOwnerToken] = sessions as [
      string,
      string,
      string,
      string,
    ];

    await db.channel.create({ data: { id: channelId, workspaceId, name: "m59-fixture" } });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "M59 fixture",
        normalizedTitle: "m59 fixture",
        topic: "fixture",
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
      data: { id: templateId, workspaceId, key: "m59", name: "M59" },
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
        createdByUserId: ownerId,
        revisions: {
          create: {
            revision: 1,
            document: {},
            configSnapshotId: configId,
            promptSnapshotId: promptId,
            promptText: "fixture",
            createdByUserId: ownerId,
          },
        },
      },
    });
    await db.sceneMediaJob.create({
      data: {
        id: sceneMediaJobId,
        workspaceId,
        scriptId,
        scriptRevision: 1,
        channelId,
        configSnapshotId: configId,
        promptSnapshotId: promptId,
        idempotencyKey: "m59-integration",
        requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
        status: "SUCCEEDED",
        schemaVersion: "1.0",
        createdByUserId: ownerId,
        scenes: {
          create: {
            id: sceneGenerationId,
            sceneId: "scene-one",
            ordinal: 0,
            sceneVersion: 1,
            status: "SUCCEEDED",
            idempotencyKey: "m59-integration-scene",
            resolvedPrompt: "fixture",
            sourceRefs: {},
            activeSlot: 1,
          },
        },
      },
    });

    await db.channel.create({
      data: { id: foreignChannelId, workspaceId: foreignWorkspaceId, name: "m59-foreign-fixture" },
    });
    await db.idea.create({
      data: {
        id: foreignIdeaId,
        workspaceId: foreignWorkspaceId,
        channelId: foreignChannelId,
        origin: "USER",
        status: "APPROVED",
        title: "M59 foreign fixture",
        normalizedTitle: "m59 foreign fixture",
        topic: "fixture",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        createdByUserId: foreignOwnerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: foreignApprovalId,
        workspaceId: foreignWorkspaceId,
        ideaId: foreignIdeaId,
        channelId: foreignChannelId,
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
        id: foreignConfigId,
        workspaceId: foreignWorkspaceId,
        version: 1,
        config: {},
        fingerprintSha256: "c".repeat(64),
        resolutionSha256: "d".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptTemplate.create({
      data: {
        id: foreignTemplateId,
        workspaceId: foreignWorkspaceId,
        key: "m59-foreign",
        name: "M59",
      },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: foreignTemplateVersionId,
        workspaceId: foreignWorkspaceId,
        templateId: foreignTemplateId,
        version: 1,
        status: "PUBLISHED",
        body: { sections: { instructions: "fixture" }, variables: [], allowedAdditionSections: [] },
        checksumSha256: "e".repeat(64),
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: foreignPromptId,
        workspaceId: foreignWorkspaceId,
        version: 1,
        configSnapshotId: foreignConfigId,
        templateId: foreignTemplateId,
        templateVersionId: foreignTemplateVersionId,
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
        id: foreignScriptId,
        workspaceId: foreignWorkspaceId,
        channelId: foreignChannelId,
        approvedIdeaSnapshotId: foreignApprovalId,
        approvedIdeaChecksum: "b".repeat(64),
        status: "APPROVED",
        currentRevision: 1,
        approvedAt: new Date(),
        createdByUserId: foreignOwnerId,
        revisions: {
          create: {
            revision: 1,
            document: {},
            configSnapshotId: foreignConfigId,
            promptSnapshotId: foreignPromptId,
            promptText: "fixture",
            createdByUserId: foreignOwnerId,
          },
        },
      },
    });
    await db.sceneMediaJob.create({
      data: {
        id: foreignSceneMediaJobId,
        workspaceId: foreignWorkspaceId,
        scriptId: foreignScriptId,
        scriptRevision: 1,
        channelId: foreignChannelId,
        configSnapshotId: foreignConfigId,
        promptSnapshotId: foreignPromptId,
        idempotencyKey: "m59-foreign-integration",
        requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
        status: "SUCCEEDED",
        schemaVersion: "1.0",
        createdByUserId: foreignOwnerId,
        scenes: {
          create: {
            id: foreignSceneGenerationId,
            sceneId: "scene-one",
            ordinal: 0,
            sceneVersion: 1,
            status: "SUCCEEDED",
            idempotencyKey: "m59-foreign-integration-scene",
            resolvedPrompt: "fixture",
            sourceRefs: {},
            activeSlot: 1,
          },
        },
      },
    });

    const assetData = (input: {
      id: string;
      rootAssetId?: string;
      version?: number;
      objectKey: string;
      body: Buffer;
      filename: string;
      workspace?: string;
    }): Parameters<typeof db.asset.create>[0]["data"] => ({
      id: input.id,
      workspaceId: input.workspace ?? workspaceId,
      objectKey: input.objectKey,
      mediaType: "image/png",
      filename: input.filename,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
      version: input.version ?? 1,
      rootAssetId: input.rootAssetId ?? input.id,
      ownership: "USER_UPLOADED",
      status: "PUBLISHED",
      licenseType: "CC0-1.0",
      rightsHolder: "fixture",
      createdByUserId: ownerId,
    });
    await db.asset.create({
      data: assetData({
        id: assetRootId,
        objectKey: assetV1Key,
        body: assetV1Body,
        filename: "one.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: assetV2Id,
        rootAssetId: assetRootId,
        version: 2,
        objectKey: assetV2Key,
        body: assetV2Body,
        filename: "two.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: foreignAssetId,
        objectKey: foreignAssetKey,
        body: foreignAssetBody,
        filename: "foreign.png",
        workspace: foreignWorkspaceId,
      }),
    });
    await db.asset.create({
      data: assetData({
        id: corruptAssetId,
        objectKey: corruptAssetKey,
        body: corruptAssetBody,
        filename: "corrupt.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: missingAssetId,
        objectKey: missingAssetKey,
        body: assetV1Body,
        filename: "missing.png",
      }),
    });

    const renderAsset = async (input: {
      id: string;
      objectKey: string;
      body: Buffer;
      workspace?: string;
    }): Promise<void> => {
      await db.asset.create({
        data: {
          id: input.id,
          workspaceId: input.workspace ?? workspaceId,
          objectKey: input.objectKey,
          mediaType: "video/mp4",
          filename: "final.mp4",
          byteSize: input.body.byteLength,
          checksumSha256: sha256Hex(input.body),
          version: 1,
          rootAssetId: input.id,
          ownership: "SYSTEM_GENERATED",
          status: "PUBLISHED",
          licenseType: "generated",
          rightsHolder: "ReelForge",
          createdByUserId: ownerId,
        },
      });
    };
    await renderAsset({ id: videoAssetId, objectKey: videoKey, body: videoBody });
    await renderAsset({
      id: expiredArtifactAssetId,
      objectKey: expiredVideoKey,
      body: expiredVideoBody,
    });
    await renderAsset({
      id: corruptArtifactAssetId,
      objectKey: corruptVideoKey,
      body: corruptVideoBody,
    });
    await renderAsset({
      id: missingArtifactAssetId,
      objectKey: missingVideoKey,
      body: missingVideoBody,
    });
    await renderAsset({
      id: foreignVideoAssetId,
      objectKey: foreignVideoKey,
      body: foreignVideoBody,
      workspace: foreignWorkspaceId,
    });

    const createJob = async (input: {
      id: string;
      status: string;
      workspace?: string;
      sceneMediaJobId?: string;
      createdByUserId?: string;
      expiredAt?: Date;
      idempotencyKey: string;
    }): Promise<void> => {
      await db.renderJob.create({
        data: {
          id: input.id,
          workspaceId: input.workspace ?? workspaceId,
          sceneMediaJobId: input.sceneMediaJobId ?? sceneMediaJobId,
          idempotencyKey: input.idempotencyKey,
          status: input.status as "SUCCEEDED" | "FAILED_FINAL",
          input: {},
          inputFingerprint: "a".repeat(64),
          retentionDays: 30,
          createdByUserId: input.createdByUserId ?? ownerId,
          ...(input.expiredAt === undefined ? {} : { expiredAt: input.expiredAt }),
        },
      });
    };
    await createJob({ id: jobId, status: "SUCCEEDED", idempotencyKey: "m59-success" });
    await createJob({ id: failedJobId, status: "FAILED_FINAL", idempotencyKey: "m59-failed" });
    await createJob({
      id: expiredJobId,
      status: "SUCCEEDED",
      idempotencyKey: "m59-expired-job",
      expiredAt: new Date(Date.now() - 1000),
    });
    await createJob({
      id: expiredArtifactJobId,
      status: "SUCCEEDED",
      idempotencyKey: "m59-expired-artifact",
    });
    await createJob({
      id: corruptArtifactJobId,
      status: "SUCCEEDED",
      idempotencyKey: "m59-corrupt-artifact",
    });
    await createJob({
      id: missingArtifactJobId,
      status: "SUCCEEDED",
      idempotencyKey: "m59-missing-artifact",
    });
    await createJob({
      id: foreignJobId,
      status: "SUCCEEDED",
      idempotencyKey: "m59-foreign",
      workspace: foreignWorkspaceId,
      sceneMediaJobId: foreignSceneMediaJobId,
      createdByUserId: foreignOwnerId,
    });

    const artifact = async (input: {
      id: string;
      jobId: string;
      assetId: string;
      objectKey: string;
      body: Buffer;
      workspace?: string;
      retainedUntil: Date | null;
    }): Promise<void> => {
      await db.renderArtifact.create({
        data: {
          id: input.id,
          workspaceId: input.workspace ?? workspaceId,
          renderJobId: input.jobId,
          kind: "VIDEO",
          assetId: input.assetId,
          assetVersion: 1,
          objectKey: input.objectKey,
          mediaType: "video/mp4",
          byteSize: input.body.byteLength,
          checksumSha256: sha256Hex(input.body),
          retainedUntil: input.retainedUntil,
        },
      });
    };
    const retainedUntil = new Date(Date.now() + 60_000);
    await artifact({
      id: videoArtifactId,
      jobId,
      assetId: videoAssetId,
      objectKey: videoKey,
      body: videoBody,
      retainedUntil,
    });
    await artifact({
      id: expiredArtifactId,
      jobId: expiredArtifactJobId,
      assetId: expiredArtifactAssetId,
      objectKey: expiredVideoKey,
      body: expiredVideoBody,
      retainedUntil: new Date(Date.now() - 1000),
    });
    await artifact({
      id: corruptArtifactId,
      jobId: corruptArtifactJobId,
      assetId: corruptArtifactAssetId,
      objectKey: corruptVideoKey,
      body: corruptVideoBody,
      retainedUntil,
    });
    await artifact({
      id: missingArtifactId,
      jobId: missingArtifactJobId,
      assetId: missingArtifactAssetId,
      objectKey: missingVideoKey,
      body: missingVideoBody,
      retainedUntil,
    });
    await artifact({
      id: foreignArtifactId,
      jobId: foreignJobId,
      assetId: foreignVideoAssetId,
      objectKey: foreignVideoKey,
      body: foreignVideoBody,
      workspace: foreignWorkspaceId,
      retainedUntil,
    });

    storage.objects.set(`${workspaceId}/${assetV1Key}`, assetV1Body);
    storage.objects.set(`${workspaceId}/${assetV2Key}`, assetV2Body);
    storage.objects.set(`${foreignWorkspaceId}/${foreignAssetKey}`, foreignAssetBody);
    storage.objects.set(
      `${workspaceId}/${corruptAssetKey}`,
      Buffer.from("not the persisted bytes"),
    );
    // missingAssetKey intentionally has no stored object.
    storage.objects.set(`${workspaceId}/${videoKey}`, videoBody);
    storage.objects.set(`${workspaceId}/${expiredVideoKey}`, expiredVideoBody);
    storage.objects.set(`${workspaceId}/${corruptVideoKey}`, Buffer.from("corrupt artifact bytes"));
    // missingVideoKey intentionally has no stored object.
    storage.objects.set(`${foreignWorkspaceId}/${foreignVideoKey}`, foreignVideoBody);

    const module = await Test.createTestingModule({ imports: [CompositionModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(STORAGE_PORT)
      .useValue(storage)
      .overrideProvider(COMPOSITION_ENGINE)
      .useValue({
        execute: async () => {
          throw new Error("engine must not run for media delivery");
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.renderArtifact.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.renderPendingObject.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.renderJob.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.sceneGenerationOutput.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.sceneGeneration.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.sceneMediaJob.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.assetUsageReference.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.asset.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.scriptRevision.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.script.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.promptBundleSnapshot.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.configSnapshot.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.promptTemplateVersion.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.promptTemplate.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.ideaApprovalSnapshot.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.idea.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.channel.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.workspace.deleteMany({
        where: { id: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.user.deleteMany({
        where: { id: { in: [ownerId, viewerId, outsiderId, foreignOwnerId] } },
      });
      await db.$disconnect();
    }
  });

  it("requires a session and current workspace membership", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const assetUrl = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content`;
    expect((await get(server, assetUrl)).status).toBe(401);
    expect((await get(server, assetUrl, outsiderToken)).status).toBe(403);
    expect((await get(server, assetUrl, foreignOwnerToken)).status).toBe(403);
    expect((await get(server, assetUrl, viewerToken)).status).toBe(200);
  });

  it("delivers immutable versions with safe media headers", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const v1 = await get(
      server,
      `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content`,
      viewerToken,
    );
    expect(v1.status).toBe(200);
    expect(v1.body).toEqual(assetV1Body);
    expect(v1.headers["content-type"]).toBe("image/png");
    expect(v1.headers["content-disposition"]).toContain("inline");
    expect(v1.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(v1.headers["accept-ranges"]).toBe("bytes");
    expect(v1.headers["x-content-type-options"]).toBe("nosniff");
    expect(v1.headers.etag).toBe(`"sha256-${sha256Hex(assetV1Body)}"`);
    expect(v1.headers["content-length"]).toBe(String(assetV1Body.byteLength));

    const v2 = await get(
      server,
      `/workspaces/${workspaceId}/assets/${assetRootId}/versions/2/content`,
      viewerToken,
    );
    expect(v2.status).toBe(200);
    expect(v2.body).toEqual(assetV2Body);

    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${assetRootId}/versions/9/content`,
          viewerToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${assetRootId}/versions/not-a-number/content`,
          viewerToken,
        )
      ).status,
    ).toBe(400);
  });

  it("denies cross-tenant asset IDs as not found", async () => {
    if (!app) return;
    const response = await get(
      app.getHttpServer(),
      `/workspaces/${workspaceId}/assets/${foreignAssetId}/versions/1/content`,
      ownerToken,
    );
    expect(response.status).toBe(404);
  });

  it("supports single ranges and rejects unsatisfiable or multiple ranges", async () => {
    if (!app) return;
    const url = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content`;
    const server = app.getHttpServer();
    const partial = await get(server, url, viewerToken, { Range: "bytes=0-3" });
    expect(partial.status).toBe(206);
    expect(partial.body).toEqual(assetV1Body.subarray(0, 4));
    expect(partial.headers["content-range"]).toBe(`bytes 0-3/${assetV1Body.byteLength}`);
    expect(partial.headers["content-length"]).toBe("4");

    const suffix = await get(server, url, viewerToken, { Range: "bytes=-4" });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toEqual(assetV1Body.subarray(assetV1Body.byteLength - 4));
    expect(suffix.headers["content-range"]).toBe(
      `bytes ${assetV1Body.byteLength - 4}-${assetV1Body.byteLength - 1}/${assetV1Body.byteLength}`,
    );

    const unsatisfiable = await get(server, url, viewerToken, { Range: "bytes=999-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(`bytes */${assetV1Body.byteLength}`);

    const multiple = await get(server, url, viewerToken, { Range: "bytes=0-1,3-4" });
    expect(multiple.status).toBe(416);

    const staleIfRange = await get(server, url, viewerToken, {
      Range: "bytes=0-1",
      "If-Range": '"sha256-other"',
    });
    expect(staleIfRange.status).toBe(200);
    expect(staleIfRange.body).toEqual(assetV1Body);
  });

  it("forces attachment downloads and supports HEAD metadata", async () => {
    if (!app) return;
    const url = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content`;
    const download = await get(app.getHttpServer(), `${url}?download=true`, viewerToken);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain("one.png");

    const head = await request(app.getHttpServer())
      .head(url)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(assetV1Body.byteLength));
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.text).toBeUndefined();
  });

  it("rejects unknown download values before reading or resolving bytes", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const assetUrl = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content?download=1`;
    expect((await get(server, assetUrl, viewerToken)).status).toBe(400);
    const missingAssetUrl = `/workspaces/${workspaceId}/assets/${missingAssetId}/versions/1/content?download=1`;
    expect((await get(server, missingAssetUrl, viewerToken)).status).toBe(400);
    const artifactUrl = `/workspaces/${workspaceId}/composition/jobs/${jobId}/artifacts/${videoArtifactId}/content?download=yes`;
    expect((await get(server, artifactUrl, viewerToken)).status).toBe(400);
  });

  it("reports missing asset bytes as not found and corrupt bytes as a conflict", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${missingAssetId}/versions/1/content`,
          viewerToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${corruptAssetId}/versions/1/content`,
          viewerToken,
        )
      ).status,
    ).toBe(409);
  });

  it("delivers a succeeded render artifact to a viewer with range and no-store caching", async () => {
    if (!app) return;
    const url = `/workspaces/${workspaceId}/composition/jobs/${jobId}/artifacts/${videoArtifactId}/content`;
    const server = app.getHttpServer();
    const full = await get(server, url, viewerToken);
    expect(full.status).toBe(200);
    expect(full.body).toEqual(videoBody);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.headers["cache-control"]).toBe("private, no-store");
    expect(full.headers["content-disposition"]).toContain("inline");
    expect(full.headers["accept-ranges"]).toBe("bytes");

    const partial = await get(server, url, viewerToken, { Range: "bytes=0-7" });
    expect(partial.status).toBe(206);
    expect(partial.body).toEqual(videoBody.subarray(0, 8));
    expect(partial.headers["content-range"]).toBe(`bytes 0-7/${videoBody.byteLength}`);

    const download = await get(server, `${url}?download=true`, viewerToken);
    expect(download.headers["content-disposition"]).toContain("attachment");
  });

  it("denies cross-tenant, failed, expired, missing, and corrupt render artifacts", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const artifactUrl = (id: string, artifactId: string): string =>
      `/workspaces/${workspaceId}/composition/jobs/${id}/artifacts/${artifactId}/content`;
    expect(
      (await get(server, artifactUrl(foreignJobId, foreignArtifactId), ownerToken)).status,
    ).toBe(404);
    expect((await get(server, artifactUrl(failedJobId, videoArtifactId), ownerToken)).status).toBe(
      409,
    );
    expect((await get(server, artifactUrl(expiredJobId, videoArtifactId), ownerToken)).status).toBe(
      410,
    );
    expect(
      (await get(server, artifactUrl(expiredArtifactJobId, expiredArtifactId), ownerToken)).status,
    ).toBe(410);
    expect((await get(server, artifactUrl(jobId, randomUUID()), ownerToken)).status).toBe(404);
    expect(
      (await get(server, artifactUrl(corruptArtifactJobId, corruptArtifactId), ownerToken)).status,
    ).toBe(409);
    expect(
      (await get(server, artifactUrl(missingArtifactJobId, missingArtifactId), ownerToken)).status,
    ).toBe(404);
  });
});
