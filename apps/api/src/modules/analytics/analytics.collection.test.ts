import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SocialProviderError } from "@reelforge/social-providers";
import { describe, expect, it, vi } from "vitest";
import { YOUTUBE_ANALYTICS_READ_SCOPE, YOUTUBE_ANALYTICS_SOURCE_API } from "./analytics.catalog.js";
import { AnalyticsService } from "./analytics.service.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const channelId = "00000000-0000-4000-8000-000000000003";
const socialAccountId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const runId = "00000000-0000-4000-8000-000000000006";
const ownerContext = { workspaceId, userId, role: "OWNER" as const };

const job = {
  id: jobId,
  channelId,
  socialAccountId,
  startDate: new Date("2026-11-01T00:00:00.000Z"),
  endDate: new Date("2026-11-01T00:00:00.000Z"),
  status: "QUEUED" as const,
  retryCount: 0,
  nextAttemptAt: new Date("2026-11-01T00:00:00.000Z"),
};

const publishedPost = {
  workspaceId,
  channelId,
  scheduledPostId: "00000000-0000-4000-8000-000000000007",
  destinationId: "00000000-0000-4000-8000-000000000008",
  publishJobId: "00000000-0000-4000-8000-000000000009",
  renderJobId: "00000000-0000-4000-8000-00000000000a",
  accountId: socialAccountId,
  platform: "YOUTUBE" as const,
  platformPostId: "video-1",
  publishedAt: "2026-11-01T10:00:00.000Z",
};

function database(): {
  metricCollectionJob: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  metricCollectionRun: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
} {
  return {
    metricCollectionJob: {
      findUnique: vi.fn().mockResolvedValue(job),
      update: vi.fn().mockResolvedValue({}),
    },
    metricCollectionRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: runId }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function channelReport(): unknown {
  return {
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
}

function videoReport(): unknown {
  return {
    columnHeaders: [
      { name: "day", columnType: "DIMENSION", dataType: "STRING" },
      { name: "video", columnType: "DIMENSION", dataType: "STRING" },
      { name: "views", columnType: "METRIC", dataType: "INTEGER" },
      { name: "likes", columnType: "METRIC", dataType: "INTEGER" },
      { name: "comments", columnType: "METRIC", dataType: "INTEGER" },
      { name: "shares", columnType: "METRIC", dataType: "INTEGER" },
      { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "FLOAT" },
    ],
    rows: [["2026-11-01", "video-1", 7, 1, 0, 0, 3.25]],
  };
}

type Harness = {
  analytics: AnalyticsService;
  db: ReturnType<typeof database>;
  youtube: { isConfigured: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  publishedPosts: {
    isConfigured: ReturnType<typeof vi.fn>;
    listPublishedRecords: ReturnType<typeof vi.fn>;
  };
  socialAccounts: { authenticatedClient: ReturnType<typeof vi.fn> };
};

function harness(): Harness {
  const db = database();
  const youtube = {
    isConfigured: vi.fn().mockReturnValue(true),
    query: vi
      .fn()
      .mockImplementation(async ({ granularity }: { granularity: "CHANNEL" | "VIDEO" }) =>
        granularity === "CHANNEL" ? channelReport() : videoReport(),
      ),
  };
  const publishedPosts = {
    isConfigured: vi.fn().mockReturnValue(true),
    listPublishedRecords: vi.fn().mockResolvedValue([publishedPost]),
  };
  const socialAccounts = {
    authenticatedClient: vi.fn().mockResolvedValue({
      account: {
        channelId,
        platform: "YOUTUBE",
        permissions: [{ permission: YOUTUBE_ANALYTICS_READ_SCOPE, status: "GRANTED" }],
      },
    }),
  };
  const analytics = new AnalyticsService(
    db as never,
    socialAccounts as never,
    youtube as never,
    publishedPosts as never,
  );
  return { analytics, db, youtube, publishedPosts, socialAccounts };
}

describe("AnalyticsService collection execution", () => {
  it("denies viewers before loading or running a collection job", async () => {
    const { analytics, db } = harness();
    await expect(
      analytics.collect({ ...ownerContext, role: "VIEWER" }, jobId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.metricCollectionJob.findUnique).not.toHaveBeenCalled();
    expect(db.metricCollectionRun.create).not.toHaveBeenCalled();
  });

  it("scopes job lookup to the requesting workspace", async () => {
    const { analytics, db } = harness();
    db.metricCollectionJob.findUnique.mockResolvedValue(null);
    await expect(analytics.collect(ownerContext, jobId)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.metricCollectionJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId, id: jobId } },
      }),
    );
  });

  it("stores provenance-bearing channel and published-video metric days", async () => {
    const { analytics, db, youtube, publishedPosts } = harness();
    const append = vi.spyOn(analytics, "appendSnapshots").mockResolvedValue(12);

    const result = await analytics.collect(ownerContext, jobId);

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      snapshotCount: 12,
      completeness: "COMPLETE",
      retryCount: 0,
    });
    expect(publishedPosts.listPublishedRecords).toHaveBeenCalledWith(ownerContext, null, 100, null);
    expect(youtube.query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ granularity: "CHANNEL", videoIds: [] }),
    );
    expect(youtube.query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ granularity: "VIDEO", videoIds: ["video-1"] }),
    );

    const values = append.mock.calls[0]?.[4] as Array<Record<string, unknown>>;
    expect(values).toHaveLength(12);
    for (const value of values) {
      expect(value).toMatchObject({
        sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-01",
        availability: "AVAILABLE",
        completeness: "COMPLETE",
      });
      expect(typeof value["collectedAt"]).toBe("string");
    }
    expect(values.find((value) => value["key"] === "subscribersGained")).toMatchObject({
      entityGranularity: "CHANNEL",
      remoteEntityId: null,
      value: 3,
    });
    expect(
      values.find(
        (value) =>
          value["key"] === "estimatedMinutesWatched" && value["entityGranularity"] === "VIDEO",
      ),
    ).toMatchObject({
      remoteEntityId: "video-1",
      value: 3.25,
      unit: "MINUTES",
    });
    expect(db.metricCollectionJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED", retryCount: 0 }),
      }),
    );
  });

  it("keeps a prior snapshot untouched and schedules backoff when the provider fails", async () => {
    const { analytics, db, youtube } = harness();
    youtube.query.mockRejectedValue(
      new SocialProviderError({
        kind: "TRANSIENT",
        code: "backendError",
        message: "YouTube is temporarily unavailable.",
        retryAfterSeconds: 120,
      }),
    );
    const append = vi.spyOn(analytics, "appendSnapshots");

    const result = await analytics.collect(ownerContext, jobId);

    expect(result).toMatchObject({
      status: "RETRY_WAIT",
      snapshotCount: 0,
      retryCount: 1,
      lastErrorCode: "backendError",
    });
    expect(append).not.toHaveBeenCalled();
    expect(db.metricCollectionRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorCode: "backendError" }),
      }),
    );
    expect(db.metricCollectionJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRY_WAIT",
          retryCount: 1,
          lastErrorCode: "backendError",
        }),
      }),
    );
  });

  it("does not retry a permanent provider rejection", async () => {
    const { analytics, db, youtube } = harness();
    youtube.query.mockRejectedValue(
      new SocialProviderError({
        kind: "PERMISSION_DENIED",
        code: "forbidden",
        message: "YouTube denied the requested account permission.",
        retryAfterSeconds: null,
      }),
    );
    const append = vi.spyOn(analytics, "appendSnapshots");

    const result = await analytics.collect(ownerContext, jobId);

    expect(result).toMatchObject({
      status: "FAILED_FINAL",
      retryCount: 0,
      lastErrorCode: "forbidden",
    });
    expect(append).not.toHaveBeenCalled();
    expect(db.metricCollectionJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED_FINAL", retryCount: 0 }),
      }),
    );
  });
});
