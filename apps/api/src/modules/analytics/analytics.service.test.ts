import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { YOUTUBE_ANALYTICS_READ_SCOPE } from "./analytics.catalog.js";
import { AnalyticsService } from "./analytics.service.js";

const ownerContext = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  role: "OWNER" as const,
};
const channelId = "00000000-0000-4000-8000-000000000003";
const socialAccountId = "00000000-0000-4000-8000-000000000004";

type MockMethod = ReturnType<typeof vi.fn>;
type MockDatabase = {
  channel: { findUnique: MockMethod };
  socialAccount: { findUnique: MockMethod };
  analyticsMetricDefinition: { findMany: MockMethod };
  metricCollectionJob: { create: MockMethod };
  analyticsMetricSnapshot: { findMany: MockMethod };
};

function database(): MockDatabase {
  return {
    channel: { findUnique: vi.fn().mockResolvedValue({ id: channelId }) },
    socialAccount: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: socialAccountId, channelId, platform: "YOUTUBE" }),
    },
    analyticsMetricDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    metricCollectionJob: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "00000000-0000-4000-8000-000000000005",
        channelId: data["channelId"],
        socialAccountId: data["socialAccountId"],
        startDate: data["startDate"],
        endDate: data["endDate"],
        status: "QUEUED",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
    },
    analyticsMetricSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function socialAccounts(grantedScope = true): { authenticatedClient: MockMethod } {
  return {
    authenticatedClient: vi.fn().mockResolvedValue({
      account: {
        channelId,
        platform: "YOUTUBE",
        permissions: [
          {
            permission: YOUTUBE_ANALYTICS_READ_SCOPE,
            status: grantedScope ? "GRANTED" : "NOT_GRANTED",
          },
        ],
      },
    }),
  };
}

function service(
  db: ReturnType<typeof database>,
  connectedAccount = socialAccounts(),
  youtubeConfigured = true,
  publishedPostsConfigured = true,
): AnalyticsService {
  return new AnalyticsService(
    db as never,
    connectedAccount as never,
    { isConfigured: () => youtubeConfigured } as never,
    { isConfigured: () => publishedPostsConfigured } as never,
  );
}

describe("AnalyticsService", () => {
  it("denies viewers before creating a collection job", async () => {
    const db = database();
    const analytics = service(db);
    await expect(
      analytics.scheduleCollection(
        { ...ownerContext, role: "VIEWER" },
        {
          channelId,
          socialAccountId,
          startDate: "2026-11-01",
          endDate: "2026-11-02",
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.channel.findUnique).not.toHaveBeenCalled();
    expect(db.metricCollectionJob.create).not.toHaveBeenCalled();
  });

  it("scopes channel lookup to the requesting workspace", async () => {
    const db = database();
    db.channel.findUnique.mockResolvedValue(null);
    const analytics = service(db);
    await expect(
      analytics.scheduleCollection(ownerContext, {
        channelId,
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.channel.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: ownerContext.workspaceId,
          id: channelId,
        },
      },
      select: { id: true },
    });
  });

  it("fails closed when the Analytics scope or connector is absent", async () => {
    const missingScope = service(database(), socialAccounts(false));
    await expect(
      missingScope.scheduleCollection(ownerContext, {
        channelId,
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const missingConnector = service(database(), socialAccounts(), false);
    await expect(
      missingConnector.scheduleCollection(ownerContext, {
        channelId,
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("queues a YouTube collection only when its account scope and ports are configured", async () => {
    const db = database();
    const analytics = service(db);
    const job = await analytics.scheduleCollection(ownerContext, {
      channelId,
      socialAccountId,
      startDate: "2026-11-01",
      endDate: "2026-11-02",
    });
    expect(job).toMatchObject({
      channelId,
      socialAccountId,
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      status: "QUEUED",
    });
    expect(db.metricCollectionJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: ownerContext.workspaceId,
          requestedByUserId: ownerContext.userId,
        }),
      }),
    );
  });

  it("returns explicit unavailable aggregates without treating missing values as zero", async () => {
    const db = database();
    db.analyticsMetricSnapshot.findMany.mockResolvedValue([
      {
        id: "snapshot-a",
        definition: { key: "views" },
        periodStart: new Date("2026-11-01T00:00:00.000Z"),
        collectedAt: new Date("2026-11-02T00:00:00.000Z"),
        sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
        availability: "AVAILABLE",
        completeness: "COMPLETE",
        value: { toString: (): string => "12" },
      },
    ]);
    const analytics = service(db);
    const results = await analytics.aggregate(ownerContext, channelId, {
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      granularity: "CHANNEL",
      socialAccountId,
    });
    const views = results.find((metric) => metric.key === "views");
    const likes = results.find((metric) => metric.key === "likes");
    expect(views).toMatchObject({ value: 12, completeness: "PARTIAL", unavailableDays: 1 });
    expect(likes).toMatchObject({ value: null, completeness: "UNAVAILABLE", unavailableDays: 2 });
    expect(db.analyticsMetricSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: ownerContext.workspaceId,
          channelId,
          socialAccountId,
          entityGranularity: "CHANNEL",
          remoteEntityId: null,
        }),
      }),
    );
  });

  it("returns the latest snapshot per metric and day for downstream intelligence", async () => {
    const db = database();
    const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const olderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    db.analyticsMetricSnapshot.findMany.mockResolvedValue([
      {
        id: latestId,
        definition: { key: "views" },
        entityGranularity: "CHANNEL",
        remoteEntityId: null,
        periodStart: new Date("2026-11-01T00:00:00.000Z"),
        periodEnd: new Date("2026-11-01T00:00:00.000Z"),
        collectedAt: new Date("2026-11-03T00:00:00.000Z"),
        sourceApi: "fixture",
        completeness: "COMPLETE",
        availability: "AVAILABLE",
        value: { toString: (): string => "15" },
        unavailableReason: null,
      },
      {
        id: olderId,
        definition: { key: "views" },
        entityGranularity: "CHANNEL",
        remoteEntityId: null,
        periodStart: new Date("2026-11-01T00:00:00.000Z"),
        periodEnd: new Date("2026-11-01T00:00:00.000Z"),
        collectedAt: new Date("2026-11-02T00:00:00.000Z"),
        sourceApi: "fixture",
        completeness: "COMPLETE",
        availability: "AVAILABLE",
        value: { toString: (): string => "12" },
        unavailableReason: null,
      },
    ]);
    const analytics = service(db);
    const snapshots = await analytics.listLatestSnapshots(ownerContext, {
      channelId,
      socialAccountId,
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      granularity: "CHANNEL",
    });
    expect(snapshots).toEqual([
      expect.objectContaining({ id: latestId, key: "views", value: 15, unit: "COUNT" }),
    ]);
    expect(db.analyticsMetricSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: ownerContext.workspaceId,
          channelId,
          socialAccountId,
          entityGranularity: "CHANNEL",
          remoteEntityId: null,
        }),
      }),
    );
  });

  it("denies snapshot reads when the channel or account is outside the workspace", async () => {
    const db = database();
    db.channel.findUnique.mockResolvedValue(null);
    await expect(
      service(db).listLatestSnapshots(ownerContext, {
        channelId,
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        granularity: "CHANNEL",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.analyticsMetricSnapshot.findMany).not.toHaveBeenCalled();
  });
});
