import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
