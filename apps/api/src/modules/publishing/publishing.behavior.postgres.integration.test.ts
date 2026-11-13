import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createDatabaseClient, type Prisma, type PrismaClient } from "@reelforge/database";
import type { CompositionService } from "../composition/composition.service.js";
import type { QualityService } from "../quality/quality.service.js";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { IdentityModule } from "../identity/identity.module.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PublishingService } from "./publishing.service.js";
import { PublishingController } from "./publishing.controller.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";
import {
  UnconfiguredPublishingBudgetPort,
  UnconfiguredPublishingSchedulePort,
} from "./publishing.ports.js";

const databaseUrl = process.env.DATABASE_URL;
type Fixture = {
  workspaceId: string;
  channelId: string;
  sceneMediaJobId: string;
  accountId: string;
  assetId: string;
};
const userId = randomUUID();
const viewerId = randomUUID();
const token = randomUUID();
const viewerToken = randomUUID();

async function fixture(db: PrismaClient): Promise<Fixture> {
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, name: "M27 offline fixture" } });
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId, userId, role: "OWNER" },
      { workspaceId, userId: viewerId, role: "VIEWER" },
    ],
  });
  const channel = await db.channel.create({ data: { workspaceId, name: "Publishing fixture" } });
  const idea = await db.idea.create({
    data: {
      workspaceId,
      channelId: channel.id,
      origin: "USER",
      title: "Fixture",
      normalizedTitle: "fixture",
      topic: "fixture",
      hook: "fixture",
      angle: "fixture",
      audience: "all",
      references: [],
      expectedFormat: "short",
      createdByUserId: userId,
    },
  });
  const snapshot = await db.ideaApprovalSnapshot.create({
    data: {
      workspaceId,
      channelId: channel.id,
      ideaId: idea.id,
      topic: "fixture",
      hook: "fixture",
      angle: "fixture",
      audience: "all",
      references: [],
      expectedFormat: "short",
      checksumSha256: "a".repeat(64),
    },
  });
  const script = await db.script.create({
    data: {
      workspaceId,
      channelId: channel.id,
      approvedIdeaSnapshotId: snapshot.id,
      approvedIdeaChecksum: "a".repeat(64),
      createdByUserId: userId,
    },
  });
  const config = await db.configSnapshot.create({
    data: {
      workspaceId,
      version: 1,
      config: {},
      fingerprintSha256: "a".repeat(64),
      resolutionSha256: "a".repeat(64),
      layers: [],
      lockedFields: [],
    },
  });
  const template = await db.promptTemplate.create({
    data: { workspaceId, key: "m27", name: "Fixture" },
  });
  const version = await db.promptTemplateVersion.create({
    data: {
      workspaceId,
      templateId: template.id,
      version: 1,
      status: "DRAFT",
      body: {},
      checksumSha256: "a".repeat(64),
    },
  });
  const prompt = await db.promptBundleSnapshot.create({
    data: {
      workspaceId,
      version: 1,
      configSnapshotId: config.id,
      templateId: template.id,
      templateVersionId: version.id,
      bundle: {},
      fingerprintSha256: "a".repeat(64),
    },
  });
  const job = await db.sceneMediaJob.create({
    data: {
      workspaceId,
      scriptId: script.id,
      scriptRevision: 1,
      channelId: channel.id,
      idempotencyKey: randomUUID(),
      requestedOutputs: {},
      configSnapshotId: config.id,
      promptSnapshotId: prompt.id,
      createdByUserId: userId,
    },
  });
  const account = await db.socialAccount.create({
    data: {
      workspaceId,
      channelId: channel.id,
      platform: "YOUTUBE",
      remoteAccountId: randomUUID(),
      displayName: "Offline fixture",
    },
  });
  const assetId = randomUUID();
  await db.asset.create({
    data: {
      id: assetId,
      workspaceId,
      rootAssetId: assetId,
      version: 1,
      ownership: "USER_UPLOADED",
      status: "PUBLISHED",
      objectKey: `${workspaceId}/fixture.mp4`,
      mediaType: "video/mp4",
      byteSize: 12,
      checksumSha256: "a".repeat(64),
    },
  });
  return {
    workspaceId,
    channelId: channel.id,
    sceneMediaJobId: job.id,
    accountId: account.id,
    assetId,
  };
}

async function render(
  db: PrismaClient,
  source: Fixture,
  status: Prisma.QualityReviewRunCreateInput["status"] = "APPROVED",
  updatedAt = new Date("2026-11-12T06:00:00Z"),
): Promise<{ renderJobId: string; qualityReviewRunId: string }> {
  const job = await db.renderJob.create({
    data: {
      workspaceId: source.workspaceId,
      sceneMediaJobId: source.sceneMediaJobId,
      idempotencyKey: randomUUID(),
      status: "SUCCEEDED",
      inputFingerprint: "a".repeat(64),
      input: {
        title: "M27 fixture render",
        scenes: [{ durationMs: 1000 }],
        profile: { transitionDurationMs: 0 },
      },
      createdByUserId: userId,
      updatedAt,
    },
  });
  await db.renderArtifact.create({
    data: {
      workspaceId: source.workspaceId,
      renderJobId: job.id,
      kind: "VIDEO",
      assetId: source.assetId,
      assetVersion: 1,
      objectKey: `${job.id}/fixture.mp4`,
      mediaType: "video/mp4",
      byteSize: 12,
      checksumSha256: "a".repeat(64),
    },
  });
  const review = await db.qualityReviewRun.create({
    data: {
      workspaceId: source.workspaceId,
      renderJobId: job.id,
      renderFamilyId: job.id,
      createdByUserId: userId,
      status,
      gateSummary: [],
      policySnapshot: {},
      disclosures: [],
      limitations: [],
    },
  });
  return { renderJobId: job.id, qualityReviewRunId: review.id };
}

function createBody(
  source: Fixture,
  output: { renderJobId: string; qualityReviewRunId: string },
  clientRequestId = randomUUID(),
): object {
  return {
    ...output,
    clientRequestId,
    channelId: source.channelId,
    scheduledAt: null,
    disclosure: { decision: "NOT_REQUIRED", reason: "Offline fixture" },
    destinations: [
      {
        platform: "YOUTUBE",
        socialAccountId: source.accountId,
        metadata: {
          platform: "YOUTUBE",
          title: "Fixture",
          description: "",
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
        },
      },
    ],
  };
}

describe.skipIf(databaseUrl === undefined)("M27 persisted publishing behavior", () => {
  const db = databaseUrl ? createDatabaseClient(databaseUrl) : undefined;
  let own: Fixture;
  let foreign: Fixture;
  let output: Awaited<ReturnType<typeof render>>;
  let publishing: PublishingService;
  let app: INestApplication;
  const assertPublishable = vi.fn().mockResolvedValue([]);
  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [userId, viewerId].map((id) => ({ id, email: `${id}@m27.invalid` })),
    });
    for (const [id, value] of [
      [userId, token],
      [viewerId, viewerToken],
    ])
      await db.session.create({
        data: {
          userId: id!,
          tokenHash: hashSessionToken(value!),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    own = await fixture(db);
    foreign = await fixture(db);
    output = await render(db, own);
    // No provider seam is invoked. These ports throw if future code tries to publish.
    publishing = new PublishingService(
      db,
      {} as CompositionService,
      { assertPublishable } as unknown as QualityService,
      { youtubeConfigured: () => false } as unknown as SocialAccountsService,
      {} as StoragePort,
      new UnconfiguredPublishingSchedulePort(),
      new UnconfiguredPublishingBudgetPort(),
      new PublishingSessionVault(undefined),
    );
    const module = await Test.createTestingModule({
      imports: [IdentityModule, WorkspaceModule],
      controllers: [PublishingController],
      providers: [{ provide: PublishingService, useValue: publishing }],
    })
      .overrideProvider("DATABASE")
      .useValue(db)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await db.workspace.deleteMany({
      where: {
        id: {
          in: [own?.workspaceId, foreign?.workspaceId].filter((id): id is string => Boolean(id)),
        },
      },
    });
    await db.user.deleteMany({ where: { id: { in: [userId, viewerId] } } });
    await db.$disconnect();
  });
  it("returns 201 on creation, 200 on replay, and 409 for a different payload", async () => {
    const path = `/workspaces/${own.workspaceId}/publishing/posts`;
    const body = createBody(own, output);
    const first = await request(app.getHttpServer() as never)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer() as never)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(200);
    expect(replay.body.id).toBe(first.body.id);
    await request(app.getHttpServer() as never)
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, scheduledAt: "2026-11-30T10:00:00Z" })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe("IDEMPOTENCY_KEY_CONFLICT"));
    expect(assertPublishable).toHaveBeenCalled();
  });
  it("re-reads the original row on a real concurrent unique-insert race", async () => {
    if (!db) return;
    const key = randomUUID();
    const body = createBody(own, output, key);
    const context: WorkspaceContext = { workspaceId: own.workspaceId, userId, role: "OWNER" };
    // A barrier ensures both pre-insert validation paths reach the quality seam before either writes.
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    assertPublishable.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return [];
    });
    try {
      const posts = await Promise.all([
        publishing.createScheduledPost(context, body),
        publishing.createScheduledPost(context, body),
      ]);
      expect(posts[0]!.id).toBe(posts[1]!.id);
      expect(
        await db.scheduledPost.count({
          where: { workspaceId: own.workspaceId, clientRequestId: key },
        }),
      ).toBe(1);
      expect(
        await db.publishingDestination.count({ where: { scheduledPostId: posts[0]!.id } }),
      ).toBe(1);
    } finally {
      assertPublishable.mockResolvedValue([]);
    }
  });
  it("lets viewers read platforms/drafts and isolates the draft workspace", async () => {
    const platforms = await request(app.getHttpServer() as never)
      .get(`/workspaces/${own.workspaceId}/publishing/platforms`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .expect(200);
    expect(platforms.body).toContainEqual({
      platform: "INSTAGRAM",
      connectable: false,
      publishable: false,
      reasonCode: "INSTAGRAM_NOT_VERIFIED",
    });
    const drafts = await publishing.drafts({
      workspaceId: own.workspaceId,
      userId,
      role: "VIEWER",
    });
    expect(drafts.items.length).toBeGreaterThan(0);
    expect(
      (await publishing.drafts({ workspaceId: foreign.workspaceId, userId, role: "VIEWER" })).items,
    ).toEqual([]);
  });
  it("excludes pending, rejected, superseded and replaced approvals with stable paging", async () => {
    if (!db) return;
    const auto = await render(db, own, "AUTO_APPROVED");
    await render(db, own, "REVIEW_REQUIRED");
    await render(db, own, "REJECTED");
    const superseded = await render(db, own);
    await db.qualityReviewRun.update({
      where: { id: superseded.qualityReviewRunId },
      data: { supersededAt: new Date() },
    });
    const replaced = await render(db, own);
    await db.qualityReviewRun.create({
      data: {
        workspaceId: own.workspaceId,
        renderJobId: replaced.renderJobId,
        renderFamilyId: replaced.renderJobId,
        createdByUserId: userId,
        status: "REVIEW_REQUIRED",
        gateSummary: [],
        policySnapshot: {},
        disclosures: [],
        limitations: [],
        createdAt: new Date(Date.now() + 1000),
      },
    });
    const foreignOutput = await render(db, foreign);
    const context: WorkspaceContext = { workspaceId: own.workspaceId, userId, role: "VIEWER" };
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await publishing.eligibleRenders(context, {
        channelId: own.channelId,
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.items.map((item) => item.renderJobId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.sort()).toEqual([output.renderJobId, auto.renderJobId].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(foreignOutput.renderJobId);
    await expect(
      publishing.eligibleRenders(context, { channelId: foreign.channelId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await publishing.eligibleRenders({ ...context, workspaceId: foreign.workspaceId }, {})
      ).items.map((item) => item.renderJobId),
    ).toEqual([foreignOutput.renderJobId]);
  });
  it("does not discover renders whose artifact asset is no longer ready", async () => {
    if (!db) return;
    const context: WorkspaceContext = { workspaceId: own.workspaceId, userId, role: "VIEWER" };
    await db.asset.update({ where: { id: own.assetId }, data: { status: "ARCHIVED" } });
    try {
      expect((await publishing.eligibleRenders(context, {})).items).toEqual([]);
    } finally {
      await db.asset.update({ where: { id: own.assetId }, data: { status: "PUBLISHED" } });
    }
  });
});
