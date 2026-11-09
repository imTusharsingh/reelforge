import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, Prisma } from "@reelforge/database";
import { ProviderError } from "@reelforge/ai-providers";
import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionService } from "../composition/composition.service.js";
import type { RenderManifest } from "../composition/composition.manifest.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import type { QualityReviewPort } from "@reelforge/ai-providers";
import { QualityService } from "./quality.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const workspaceId = randomUUID();
const userId = randomUUID();
const channelId = randomUUID();
const genreId = randomUUID();
const ideaId = randomUUID();
const ideaSnapshotId = randomUUID();
const scriptId = randomUUID();
const assetId = randomUUID();
const configSnapshotId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
const promptSnapshotId = randomUUID();
const sceneMediaJobId = randomUUID();
const blockedRenderJobId = randomUUID();
const manualRenderJobId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId, role: "OWNER" };
const renderProfile = {
  ...DEFAULT_RENDER_PROFILE,
  captionSafeMarginPixels: 120,
  transition: "CUT" as const,
  transitionDurationMs: 0,
};

function renderInput(renderJobId: string): RenderCompositionInput {
  return {
    schemaVersion: "1.0",
    title: "Quality integration",
    profile: renderProfile,
    sourceMediaPackage: {
      jobId: sceneMediaJobId,
      scriptId,
      scriptRevision: 1,
      schemaVersion: "1.0",
    },
    scenes: [
      {
        sceneId: "scene-one",
        assetId,
        assetVersion: 1,
        image: true,
        durationMs: 1000,
        captions: [{ text: "caption", startMs: 0, endMs: 500 }],
      },
    ],
    audio: [],
    coverFrames: [{ assetId, assetVersion: 1, timestampMs: 0 }],
    renderSeed: renderJobId,
  };
}

function manifest(jobId: string, input: RenderCompositionInput): RenderManifest {
  return {
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
      byteSize: 64,
      checksumSha256: "a".repeat(64),
      durationMs: 1000,
    },
    artifactOrder: ["VIDEO", "COVER", "MANIFEST"],
    covers: [],
  };
}

suite("QualityService PostgreSQL persistence", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const blockedInput = renderInput(blockedRenderJobId);
  const manualInput = renderInput(manualRenderJobId);
  const composition = {
    getManifest: async (_context: WorkspaceContext, jobId: string): Promise<RenderManifest> =>
      manifest(jobId, jobId === blockedRenderJobId ? blockedInput : manualInput),
  } as unknown as CompositionService;
  const unconfiguredPort: QualityReviewPort = {
    review: async (request) => {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "No real AI quality-review adapter is configured",
        request.correlationId,
      );
    },
  };
  const quality = db
    ? new QualityService(db as Database, composition, unconfiguredPort)
    : undefined;

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({
      data: { id: userId, email: `${userId}@quality.integration.invalid` },
    });
    await db.workspace.create({ data: { id: workspaceId, name: "quality-integration" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "quality" } });
    await db.genre.create({
      data: {
        id: genreId,
        workspaceId,
        name: "Science",
        audience: "all",
        tone: "plain",
        topicsAllowed: [],
        topicsBlocked: ["blocked phrase"],
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
        title: "Approved idea",
        normalizedTitle: "approved idea",
        topic: "topic",
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
        id: ideaSnapshotId,
        workspaceId,
        ideaId,
        channelId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        checksumSha256: "b".repeat(64),
      },
    });
    await db.script.create({
      data: {
        id: scriptId,
        workspaceId,
        channelId,
        approvedIdeaSnapshotId: ideaSnapshotId,
        approvedIdeaChecksum: "b".repeat(64),
        createdByUserId: userId,
      },
    });
    await db.scriptRevision.create({
      data: {
        workspaceId,
        scriptId,
        revision: 1,
        document: {
          schemaVersion: "1.0",
          title: "Quality test",
          hook: "Hook",
          dialogue: "blocked phrase",
          cta: "CTA",
          metadata: { genre: "Science", targetDurationSeconds: 1, factual: false },
          scenes: [
            {
              id: "scene-one",
              startSeconds: 0,
              durationSeconds: 1,
              characterRefs: [],
              dialogue: "blocked phrase",
              visualDescription: "A test scene",
              camera: "Static",
              audioCues: [],
            },
          ],
        },
        createdByUserId: userId,
      },
    });
    await db.asset.create({
      data: {
        id: assetId,
        workspaceId,
        objectKey: `${workspaceId}/quality-integration.png`,
        mediaType: "image/png",
        version: 1,
        rootAssetId: assetId,
        ownership: "USER_UPLOADED",
        status: "PUBLISHED",
        licenseType: "CC0-1.0",
        licenseTerms: "Integration fixture",
        rightsHolder: "Fixture",
        rightsAttestedAt: new Date(),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
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
      data: { id: templateId, workspaceId, key: "quality-test", name: "Quality test" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "DRAFT",
        body: {},
        checksumSha256: "e".repeat(64),
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
        bundle: {},
        fingerprintSha256: "f".repeat(64),
      },
    });
    await db.sceneMediaJob.create({
      data: {
        id: sceneMediaJobId,
        workspaceId,
        scriptId,
        scriptRevision: 1,
        channelId,
        idempotencyKey: `quality-${sceneMediaJobId}`,
        requestedOutputs: {},
        configSnapshotId,
        promptSnapshotId,
        createdByUserId: userId,
      },
    });
    for (const [id, input] of [
      [blockedRenderJobId, blockedInput],
      [manualRenderJobId, manualInput],
    ] as const) {
      await db.renderJob.create({
        data: {
          id,
          workspaceId,
          sceneMediaJobId,
          idempotencyKey: `quality-${id}`,
          status: "SUCCEEDED",
          inputFingerprint: "a".repeat(64),
          input: input as Prisma.InputJsonValue,
          createdByUserId: userId,
        },
      });
      await db.assetUsageReference.create({
        data: {
          workspaceId,
          assetId,
          assetVersion: 1,
          usedByType: "render_input",
          usedById: id,
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("persists and decides blocked and unconfigured review runs", async () => {
    if (!db || !quality) throw new Error("DATABASE_URL is required for this integration suite");
    const blocked = await quality.create(context, { renderJobId: blockedRenderJobId });
    expect(blocked.status).toBe("BLOCKED");
    const storedBlocked = await db.qualityReviewRun.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: blocked.id } },
    });
    expect(storedBlocked.scorecard).toBeNull();
    const rejected = await quality.decide(context, blocked.id, {
      action: "REJECT",
      reason: "Blocked topic",
    });
    expect(rejected.status).toBe("REJECTED");

    await db.genre.update({ where: { id: genreId }, data: { topicsBlocked: [] } });
    const manual = await quality.create(context, { renderJobId: manualRenderJobId });
    expect(manual.status).toBe("REVIEW_REQUIRED");
    expect(manual.scorecard).toBeNull();
    const storedManual = await db.qualityReviewRun.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: manual.id } },
    });
    expect(storedManual.scorecard).toBeNull();
    const approved = await quality.decide(context, manual.id, {
      action: "APPROVE",
      reason: "Manual review completed; hard gates pass",
    });
    expect(approved.status).toBe("APPROVED");
  });
});
