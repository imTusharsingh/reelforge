import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { SocialProviderError } from "@reelforge/social-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { YOUTUBE_ANALYTICS_READ_SCOPE, YOUTUBE_ANALYTICS_SOURCE_API } from "./analytics.catalog.js";
import { AnalyticsService } from "./analytics.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const channelId = randomUUID();
const accountId = randomUUID();
const jobId = randomUUID();
const runId = randomUUID();
const missingRunId = randomUUID();
const revisionRunId = randomUUID();
const snapshotId = randomUUID();

suite("M14 PostgreSQL persistence", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@analytics.integration.invalid` },
        { id: otherUserId, email: `${otherUserId}@analytics.integration.invalid` },
      ],
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "analytics-integration" },
        { id: otherWorkspaceId, name: "other-analytics-integration" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId, role: "OWNER" },
        { workspaceId: otherWorkspaceId, userId: otherUserId, role: "OWNER" },
      ],
    });
    await db.channel.create({
      data: { id: channelId, workspaceId, name: "analytics-integration" },
    });
    await db.socialAccount.create({
      data: {
        id: accountId,
        workspaceId,
        channelId,
        platform: "YOUTUBE",
        remoteAccountId: "UC-analytics-fixture",
        displayName: "Analytics fixture",
      },
    });
    await db.metricCollectionJob.create({
      data: {
        id: jobId,
        workspaceId,
        channelId,
        socialAccountId: accountId,
        requestedByUserId: userId,
        startDate: new Date("2026-11-01T00:00:00.000Z"),
        endDate: new Date("2026-11-01T00:00:00.000Z"),
      },
    });
    await db.metricCollectionRun.create({
      data: {
        id: runId,
        workspaceId,
        jobId,
        attempt: 1,
        status: "SUCCEEDED",
        sourceApi: "fixture",
        startDate: new Date("2026-11-01T00:00:00.000Z"),
        endDate: new Date("2026-11-01T00:00:00.000Z"),
        completeness: "COMPLETE",
        finishedAt: new Date("2026-11-02T00:00:00.000Z"),
      },
    });
    const definition = await db.analyticsMetricDefinition.findUniqueOrThrow({
      where: { platform_key: { platform: "YOUTUBE", key: "views" } },
      select: { id: true },
    });
    await db.analyticsMetricSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        channelId,
        socialAccountId: accountId,
        runId,
        metricDefinitionId: definition.id,
        entityGranularity: "CHANNEL",
        periodStart: new Date("2026-11-01T00:00:00.000Z"),
        periodEnd: new Date("2026-11-01T00:00:00.000Z"),
        collectedAt: new Date("2026-11-02T00:00:00.000Z"),
        sourceApi: "fixture",
        completeness: "COMPLETE",
        availability: "AVAILABLE",
        value: 13,
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.$disconnect();
  });

  it("denies cross-workspace metric reads and collection-job references", async () => {
    if (!db) return;
    const service = new AnalyticsService(
      db,
      {
        authenticatedClient: async (): Promise<never> => {
          throw new Error("not used");
        },
      } as never,
      { isConfigured: () => false } as never,
      { isConfigured: () => false } as never,
    );
    await expect(
      service.aggregate(
        { workspaceId: otherWorkspaceId, userId: otherUserId, role: "OWNER" },
        channelId,
        {
          startDate: "2026-11-01",
          endDate: "2026-11-01",
          granularity: "CHANNEL",
          socialAccountId: accountId,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      db.metricCollectionJob.create({
        data: {
          workspaceId: otherWorkspaceId,
          channelId,
          socialAccountId: accountId,
          requestedByUserId: otherUserId,
          startDate: new Date("2026-11-01T00:00:00.000Z"),
          endDate: new Date("2026-11-01T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("preserves valid data when a later report is missing and appends revisions", async () => {
    if (!db) return;
    await db.metricCollectionRun.createMany({
      data: [
        {
          id: missingRunId,
          workspaceId,
          jobId,
          attempt: 2,
          status: "SUCCEEDED",
          sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
          startDate: new Date("2026-11-01T00:00:00.000Z"),
          endDate: new Date("2026-11-01T00:00:00.000Z"),
          completeness: "PARTIAL",
          finishedAt: new Date("2026-11-03T00:00:00.000Z"),
        },
        {
          id: revisionRunId,
          workspaceId,
          jobId,
          attempt: 3,
          status: "SUCCEEDED",
          sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
          startDate: new Date("2026-11-01T00:00:00.000Z"),
          endDate: new Date("2026-11-01T00:00:00.000Z"),
          completeness: "COMPLETE",
          finishedAt: new Date("2026-11-04T00:00:00.000Z"),
        },
      ],
    });
    const service = new AnalyticsService(
      db,
      {
        authenticatedClient: async (): Promise<never> => {
          throw new Error("not used");
        },
      } as never,
      { isConfigured: () => false } as never,
      { isConfigured: () => false } as never,
    );
    const context = { workspaceId, userId, role: "OWNER" as const };
    const reportingPeriod = {
      periodStart: "2026-11-01",
      periodEnd: "2026-11-01",
      entityGranularity: "CHANNEL" as const,
      remoteEntityId: null,
      unit: "COUNT" as const,
      sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
    };

    await expect(
      service.appendSnapshots(context, channelId, accountId, missingRunId, [
        {
          ...reportingPeriod,
          key: "views",
          value: null,
          collectedAt: "2026-11-03T00:00:00.000Z",
          completeness: "PARTIAL",
          availability: "UNAVAILABLE",
          unavailableReason: "NO_REPORT_ROW",
        },
      ]),
    ).resolves.toBe(0);

    await expect(
      service.appendSnapshots(context, channelId, accountId, revisionRunId, [
        {
          ...reportingPeriod,
          key: "views",
          value: 15,
          collectedAt: "2026-11-04T00:00:00.000Z",
          completeness: "COMPLETE",
          availability: "AVAILABLE",
          unavailableReason: null,
        },
      ]),
    ).resolves.toBe(1);

    const snapshots = await db.analyticsMetricSnapshot.findMany({
      where: { workspaceId, channelId, socialAccountId: accountId },
      orderBy: { collectedAt: "desc" },
      select: { id: true, value: true, supersedesSnapshotId: true },
    });
    expect(snapshots).toHaveLength(2);
    expect(Number(snapshots[0]?.value)).toBe(15);
    expect(snapshots[0]?.supersedesSnapshotId).toBe(snapshotId);

    const aggregates = await service.aggregate(context, channelId, {
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      granularity: "CHANNEL",
    });
    expect(aggregates.find((metric) => metric.key === "views")).toMatchObject({
      value: 15,
      completeness: "COMPLETE",
      unavailableDays: 0,
    });
  });

  it("keeps successful metric snapshots immutable", async () => {
    if (!db) return;
    await expect(
      db.analyticsMetricSnapshot.update({
        where: { id: snapshotId },
        data: { value: 99 },
      }),
    ).rejects.toBeDefined();
    const snapshot = await db.analyticsMetricSnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
      select: { value: true },
    });
    expect(Number(snapshot.value)).toBe(13);
  });

  it("collects provenance-bearing snapshots and keeps them when a later API call fails", async () => {
    if (!db) return;
    let failProvider = false;
    const publishedPost = {
      workspaceId,
      channelId,
      scheduledPostId: randomUUID(),
      destinationId: randomUUID(),
      publishJobId: randomUUID(),
      renderJobId: randomUUID(),
      accountId,
      platform: "YOUTUBE" as const,
      platformPostId: "fixture-video",
      publishedAt: "2026-11-01T10:00:00.000Z",
    };
    const channelReport = {
      columnHeaders: [
        { name: "day", columnType: "DIMENSION", dataType: "STRING" },
        { name: "views", columnType: "METRIC", dataType: "INTEGER" },
        { name: "likes", columnType: "METRIC", dataType: "INTEGER" },
        { name: "comments", columnType: "METRIC", dataType: "INTEGER" },
        { name: "shares", columnType: "METRIC", dataType: "INTEGER" },
        { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "FLOAT" },
        { name: "subscribersGained", columnType: "METRIC", dataType: "INTEGER" },
        { name: "subscribersLost", columnType: "METRIC", dataType: "INTEGER" },
      ],
      rows: [["2026-11-01", 10, 2, 1, 1, 5.5, 3, 1]],
    };
    const videoReport = {
      columnHeaders: [
        { name: "day", columnType: "DIMENSION", dataType: "STRING" },
        { name: "video", columnType: "DIMENSION", dataType: "STRING" },
        { name: "views", columnType: "METRIC", dataType: "INTEGER" },
        { name: "likes", columnType: "METRIC", dataType: "INTEGER" },
        { name: "comments", columnType: "METRIC", dataType: "INTEGER" },
        { name: "shares", columnType: "METRIC", dataType: "INTEGER" },
        { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "FLOAT" },
      ],
      rows: [["2026-11-01", "fixture-video", 7, 1, 0, 0, 3.25]],
    };
    const service = new AnalyticsService(
      db,
      {
        authenticatedClient: async () => ({
          account: {
            channelId,
            platform: "YOUTUBE",
            permissions: [{ permission: YOUTUBE_ANALYTICS_READ_SCOPE, status: "GRANTED" }],
          },
        }),
      } as never,
      {
        isConfigured: () => true,
        query: async ({ granularity }: { granularity: "CHANNEL" | "VIDEO" }) => {
          if (failProvider)
            throw new SocialProviderError({
              kind: "TRANSIENT",
              code: "backendError",
              message: "YouTube is temporarily unavailable.",
              retryAfterSeconds: 60,
            });
          return granularity === "CHANNEL" ? channelReport : videoReport;
        },
      } as never,
      {
        isConfigured: () => true,
        listPublishedRecords: async () => [publishedPost],
      } as never,
    );
    const context = { workspaceId, userId, role: "OWNER" as const };
    const before = await db.analyticsMetricSnapshot.count({
      where: { workspaceId, channelId, socialAccountId: accountId },
    });

    const result = await service.collect(context, jobId);
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      snapshotCount: 12,
      completeness: "COMPLETE",
    });

    const collected = await db.analyticsMetricSnapshot.findMany({
      where: { runId: result.runId },
      include: { definition: { select: { key: true } } },
    });
    expect(collected).toHaveLength(12);
    for (const snapshot of collected) {
      expect(snapshot.sourceApi).toBe(YOUTUBE_ANALYTICS_SOURCE_API);
      expect(snapshot.periodStart.toISOString().slice(0, 10)).toBe("2026-11-01");
      expect(snapshot.periodEnd.toISOString().slice(0, 10)).toBe("2026-11-01");
      expect(snapshot.collectedAt).toBeInstanceOf(Date);
    }
    const videoViews = collected.find(
      (snapshot) => snapshot.definition.key === "views" && snapshot.entityGranularity === "VIDEO",
    );
    expect(videoViews).toMatchObject({
      remoteEntityId: "fixture-video",
      availability: "AVAILABLE",
    });
    expect(Number(videoViews?.value)).toBe(7);

    const afterSuccess = await db.analyticsMetricSnapshot.count({
      where: { workspaceId, channelId, socialAccountId: accountId },
    });
    expect(afterSuccess).toBeGreaterThan(before);

    failProvider = true;
    const failed = await service.collect(context, jobId);
    expect(failed).toMatchObject({ status: "RETRY_WAIT", snapshotCount: 0 });
    const afterFailure = await db.analyticsMetricSnapshot.count({
      where: { workspaceId, channelId, socialAccountId: accountId },
    });
    expect(afterFailure).toBe(afterSuccess);
    const preserved = await db.analyticsMetricSnapshot.findMany({
      where: { runId: result.runId },
      select: { id: true, value: true },
    });
    expect(preserved).toEqual(
      collected.map((snapshot) => ({ id: snapshot.id, value: snapshot.value })),
    );
  });
});
