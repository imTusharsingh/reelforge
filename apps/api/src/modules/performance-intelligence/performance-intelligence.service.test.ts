import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { LatestMetricSnapshot, PerformanceDimensionSummary } from "@reelforge/contracts";
import { describe, expect, it, vi } from "vitest";
import { PerformanceIntelligenceService } from "./performance-intelligence.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "11111111-1111-4111-8111-1111111111ff";
const userId = "11111111-1111-4111-8111-111111111112";
const channelId = "11111111-1111-4111-8111-111111111113";
const accountId = "11111111-1111-4111-8111-111111111114";
const reportId = "11111111-1111-4111-8111-111111111115";
const recommendationId = "11111111-1111-4111-8111-111111111116";
const experimentId = "11111111-1111-4111-8111-111111111117";
const strategyChangeId = "11111111-1111-4111-8111-111111111118";
const videoIds = [
  "11111111-1111-4111-8111-111111111119",
  "11111111-1111-4111-8111-111111111120",
  "11111111-1111-4111-8111-111111111121",
] as const;

type PublishedRecordFixture = {
  workspaceId: string;
  channelId: string;
  scheduledPostId: string;
  destinationId: string;
  publishJobId: string;
  renderJobId: string;
  accountId: string;
  platform: "YOUTUBE";
  platformPostId: string;
  publishedAt: string;
};

type PublishedContextFixture = {
  scheduledPostId: string;
  channelId: string;
  renderJobId: string;
  topic: string;
  hook: string;
  seriesId: null;
  seriesName: string | null;
  characterNames: string[];
  durationSeconds: number;
};

const ownerContext = { workspaceId, userId, role: "OWNER" as const };
const viewerContext = { workspaceId, userId, role: "VIEWER" as const };

const metricKeys = [
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const;

type MockMethod = ReturnType<typeof vi.fn>;

function snapshot(
  key: (typeof metricKeys)[number],
  value: number,
  options: {
    granularity?: "CHANNEL" | "VIDEO";
    remoteEntityId?: string | null;
    day: string;
    id: string;
  },
): LatestMetricSnapshot {
  return {
    id: options.id,
    key,
    value,
    unit: key === "estimatedMinutesWatched" ? "MINUTES" : "COUNT",
    entityGranularity: options.granularity ?? "CHANNEL",
    remoteEntityId: options.remoteEntityId ?? null,
    periodStart: options.day,
    periodEnd: options.day,
    collectedAt: `${options.day}T06:00:00.000Z`,
    sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
    completeness: "COMPLETE",
    availability: "AVAILABLE",
    unavailableReason: null,
  };
}

function channelSnapshots(
  days: readonly string[],
  multiplier: number,
  prefix: string,
): LatestMetricSnapshot[] {
  const result: LatestMetricSnapshot[] = [];
  for (const [index, day] of days.entries()) {
    for (const [metricIndex, key] of metricKeys.entries()) {
      const base = {
        views: 100,
        likes: 10,
        comments: 4,
        shares: 2,
        estimatedMinutesWatched: 50,
        subscribersGained: 5,
        subscribersLost: 1,
      }[key];
      result.push(
        snapshot(key, base * multiplier, {
          day,
          id: `${prefix.slice(0, 34)}${(index * 10 + metricIndex).toString(16).padStart(2, "0")}`,
        }),
      );
    }
  }
  return result;
}

function videoSnapshots(): LatestMetricSnapshot[] {
  return videoIds.map((remoteEntityId, index) =>
    snapshot("views", 300 + index * 100, {
      granularity: "VIDEO",
      remoteEntityId,
      day: "2026-11-02",
      id: `22222222-2222-4222-8222-2222222222${String(index).padStart(2, "0")}`,
    }),
  );
}

function publishedRecords(): PublishedRecordFixture[] {
  return videoIds.map((videoId, index) => ({
    workspaceId,
    channelId,
    scheduledPostId: `33333333-3333-4333-8333-3333333333${String(index).padStart(2, "0")}`,
    destinationId: `44444444-4444-4444-8444-4444444444${String(index).padStart(2, "0")}`,
    publishJobId: `55555555-5555-4555-8555-5555555555${String(index).padStart(2, "0")}`,
    renderJobId: `66666666-6666-4666-8666-6666666666${String(index).padStart(2, "0")}`,
    accountId,
    platform: "YOUTUBE" as const,
    platformPostId: videoId,
    publishedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
  }));
}

function publishedContexts(): PublishedContextFixture[] {
  return publishedRecords().map((record) => ({
    scheduledPostId: record.scheduledPostId,
    channelId,
    renderJobId: record.renderJobId,
    topic: "AI tools",
    hook: "Question",
    seriesId: null,
    seriesName: null,
    characterNames: ["Nova"],
    durationSeconds: 120,
  }));
}

type MockDatabase = {
  channel: { findUnique: MockMethod };
  providerRequest: { create: MockMethod; update: MockMethod };
  performanceInsightReport: { create: MockMethod; findUnique: MockMethod; findMany: MockMethod };
  performanceRecommendation: {
    create: MockMethod;
    findUnique: MockMethod;
    findMany: MockMethod;
    updateMany: MockMethod;
  };
  performanceExperiment: {
    create: MockMethod;
    findUnique: MockMethod;
    findMany: MockMethod;
    updateMany: MockMethod;
  };
  performanceStrategyChange: {
    create: MockMethod;
    findUnique: MockMethod;
    findFirst: MockMethod;
    findMany: MockMethod;
  };
  $transaction: MockMethod;
};

function database(): MockDatabase {
  const db = {
    channel: { findUnique: vi.fn().mockResolvedValue({ id: channelId }) },
    providerRequest: { create: vi.fn(), update: vi.fn() },
    performanceInsightReport: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: reportId,
        ...data,
        narrative: data["narrative"] ?? null,
        providerId: data["providerId"] ?? null,
        modelVersion: data["modelVersion"] ?? null,
        promptVersion: data["promptVersion"] ?? null,
        cost: data["cost"] ?? null,
        costCurrency: data["costCurrency"] ?? null,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    performanceRecommendation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: recommendationId,
        ...data,
        status: data["status"] ?? "PROPOSED",
        approvedAt: null,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    performanceExperiment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: experimentId,
        ...data,
        exposure: data["exposure"] ?? null,
        outcome: data["outcome"] ?? null,
        status: "DRAFT",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    performanceStrategyChange: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: strategyChangeId,
        ...data,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as MockDatabase;
  db.$transaction = vi.fn(async (callback: (transaction: MockDatabase) => unknown) => callback(db));
  return db;
}

function paidUsage(): { reservePaidCall: MockMethod; finishPaidCall: MockMethod } {
  return {
    reservePaidCall: vi.fn().mockResolvedValue({
      workspaceId,
      reservationId: "reservation-a",
      currency: "USD",
      estimateMinor: 1,
    }),
    finishPaidCall: vi.fn().mockResolvedValue(undefined),
  };
}

function analytics(
  current: readonly LatestMetricSnapshot[] = [],
  previous: readonly LatestMetricSnapshot[] = [],
  currentVideo: readonly LatestMetricSnapshot[] = [],
): { listLatestSnapshots: MockMethod } {
  return {
    listLatestSnapshots: vi.fn(
      async (
        _context: unknown,
        query: { granularity: "CHANNEL" | "VIDEO"; startDate: string },
      ): Promise<LatestMetricSnapshot[]> => {
        if (query.granularity === "CHANNEL")
          return query.startDate === "2026-11-01" ? [...current] : [...previous];
        return query.startDate === "2026-11-01" ? [...currentVideo] : [];
      },
    ),
  };
}

function publishing(
  records: PublishedRecordFixture[] = publishedRecords(),
  contexts: PublishedContextFixture[] = publishedContexts(),
): { listPublishedRecords: MockMethod; listPublishedPostContexts: MockMethod } {
  return {
    listPublishedRecords: vi.fn().mockResolvedValue(records),
    listPublishedPostContexts: vi.fn().mockResolvedValue(contexts),
  };
}

function llm(
  configured = false,
  fail = false,
): { capability: Record<string, unknown>; isConfigured: () => boolean; generate: MockMethod } {
  return {
    capability: {
      providerId: "fixture-llm",
      capabilityId: "insight-report-llm",
      kind: "llm" as const,
      input: ["text" as const],
      output: ["text" as const],
      supportsReferenceImages: false,
      asynchronous: false,
      polling: false,
      regions: [],
      costModel: { currency: "USD", unit: "request" as const, amount: 0.01 },
    },
    isConfigured: (): boolean => configured,
    generate: vi.fn(
      async (): Promise<{
        narrative: string;
        provenance: {
          modelVersion: string;
          promptVersion: string;
          cost: number;
          currency: string;
        };
      }> => {
        if (fail) throw new Error("provider unavailable");
        return {
          narrative: "Short-form AI tool demos over-perform on this channel.",
          provenance: {
            modelVersion: "fixture-model-1",
            promptVersion: "insight-v1",
            cost: 0.01,
            currency: "USD",
          },
        };
      },
    ),
  };
}

function service(
  db: MockDatabase,
  analyticsPort = analytics(),
  publishingPort = publishing(),
  llmPort = llm(),
  usagePort = paidUsage(),
): PerformanceIntelligenceService {
  return new PerformanceIntelligenceService(
    db as never,
    analyticsPort as never,
    publishingPort as never,
    llmPort as never,
    usagePort as never,
  );
}

function dimensionSummary(
  overrides: Partial<PerformanceDimensionSummary> = {},
): PerformanceDimensionSummary {
  return {
    dimension: "TOPIC",
    value: "AI tools",
    status: "OK",
    sample: { videos: 12, days: 14, snapshots: 40 },
    minimumSample: { videos: 3, days: 1, snapshots: 3 },
    totalViews: 4000,
    exposureDays: 10,
    averageViewsPerVideoDay: 400,
    engagementRate: 0.12,
    watchMinutesPerView: 0.8,
    netSubscribers: 40,
    snapshotIds: ["77777777-7777-4777-8777-777777777777"],
    publishedPostIds: ["33333333-3333-4333-8333-333333333300"],
    limitations: [],
    ...overrides,
  };
}

function reportRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: reportId,
    workspaceId,
    channelId,
    periodStart: new Date("2026-11-01T00:00:00.000Z"),
    periodEnd: new Date("2026-11-03T00:00:00.000Z"),
    comparisonStart: new Date("2026-10-29T00:00:00.000Z"),
    comparisonEnd: new Date("2026-10-31T00:00:00.000Z"),
    status: "GENERATED",
    kpis: [],
    dimensionSummaries: [dimensionSummary()],
    narrative: null,
    aiStatus: "NOT_CONFIGURED",
    providerId: null,
    modelVersion: null,
    promptVersion: null,
    cost: null,
    costCurrency: null,
    limitations: [],
    snapshotIds: [],
    createdByUserId: userId,
    createdAt: new Date("2026-11-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("PerformanceIntelligenceService", () => {
  it("reserves before the insight provider and charges a dispatched failure at estimate", async () => {
    const db = database();
    const events: string[] = [];
    const usage = paidUsage();
    usage.reservePaidCall.mockImplementation(async () => {
      events.push("reserve");
      return { workspaceId, reservationId: "reservation-a", currency: "USD", estimateMinor: 1 };
    });
    db.providerRequest.create.mockImplementation(async () => {
      events.push("ledger");
    });
    const insightLlm = llm(true, true);
    insightLlm.generate.mockImplementation(async () => {
      events.push("dispatch");
      throw new Error("provider failed");
    });
    await expect(
      service(
        db,
        analytics(
          channelSnapshots(
            ["2026-11-01", "2026-11-02", "2026-11-03"],
            1,
            "11111111-1111-4111-8111-111111111111",
          ),
          channelSnapshots(
            ["2026-10-29", "2026-10-30", "2026-10-31"],
            1,
            "22222222-2222-4222-8222-222222222222",
          ),
          videoSnapshots(),
        ),
        publishing(),
        insightLlm,
        usage,
      ).generateInsightReport(ownerContext, {
        channelId,
        socialAccountId: accountId,
        startDate: "2026-11-01",
        endDate: "2026-11-03",
      }),
    ).resolves.toMatchObject({ aiStatus: "NOT_GENERATED" });
    expect(events).toEqual(["reserve", "ledger", "dispatch"]);
    expect(usage.finishPaidCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatched: true, actualCost: null }),
    );
  });

  it("exposes every KPI with comparison windows and minimum sample rules", () => {
    const definitions = service(database()).kpiDefinitions();
    expect(definitions.map((definition) => definition.key)).toEqual([
      "TOTAL_VIEWS",
      "ENGAGEMENT_RATE",
      "WATCH_MINUTES_PER_VIEW",
      "NET_SUBSCRIBERS",
      "VIEWS_PER_DAY",
    ]);
    for (const definition of definitions) {
      expect(definition.comparisonWindowDays).toBeGreaterThan(0);
      expect(definition.minimumSample.days).toBeGreaterThan(0);
      expect(definition.minimumSample.snapshots).toBeGreaterThan(0);
    }
  });

  it("denies viewers before reading or persisting performance data", async () => {
    const db = database();
    await expect(
      service(db).generateInsightReport(viewerContext, {
        channelId,
        socialAccountId: accountId,
        startDate: "2026-11-01",
        endDate: "2026-11-03",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.channel.findUnique).not.toHaveBeenCalled();
    expect(db.performanceInsightReport.create).not.toHaveBeenCalled();
  });

  it("scopes channel lookups to the requesting workspace", async () => {
    const db = database();
    db.channel.findUnique.mockResolvedValue(null);
    await expect(
      service(db).generateInsightReport(
        { workspaceId: otherWorkspaceId, userId, role: "OWNER" },
        {
          channelId,
          socialAccountId: accountId,
          startDate: "2026-11-01",
          endDate: "2026-11-03",
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.channel.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: otherWorkspaceId, id: channelId } },
      select: { id: true },
    });
    expect(db.performanceInsightReport.create).not.toHaveBeenCalled();
  });

  it("reports insufficient data instead of a confident conclusion", async () => {
    const db = database();
    const llmPort = llm(true);
    const report = await service(db, analytics(), publishing(), llmPort).generateInsightReport(
      ownerContext,
      {
        channelId,
        socialAccountId: accountId,
        startDate: "2026-11-01",
        endDate: "2026-11-03",
      },
    );
    expect(report).toMatchObject({
      status: "INSUFFICIENT_DATA",
      aiStatus: "INSUFFICIENT_DATA",
      narrative: null,
    });
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(llmPort.generate).not.toHaveBeenCalled();
    expect(db.performanceInsightReport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId,
          channelId,
          status: "INSUFFICIENT_DATA",
          createdByUserId: userId,
        }),
      }),
    );
  });

  it("links generated reports to snapshot IDs and records AI provenance", async () => {
    const db = database();
    const current = channelSnapshots(
      ["2026-11-01", "2026-11-02", "2026-11-03"],
      1,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const previous = channelSnapshots(
      ["2026-10-29", "2026-10-30", "2026-10-31"],
      0.5,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const llmPort = llm(true);
    const report = await service(
      db,
      analytics(current, previous, videoSnapshots()),
      publishing(),
      llmPort,
    ).generateInsightReport(ownerContext, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });

    expect(report.status).toBe("GENERATED");
    expect(report.aiStatus).toBe("GENERATED");
    expect(report.narrative).toContain("over-perform");
    expect(report.provider).toMatchObject({
      providerId: "fixture-llm",
      modelVersion: "fixture-model-1",
      promptVersion: "insight-v1",
      cost: 0.01,
      currency: "USD",
    });
    expect(report.snapshotIds.length).toBeGreaterThan(0);
    expect(report.kpis.find((kpi) => kpi.key === "TOTAL_VIEWS")).toMatchObject({
      status: "OK",
      value: 300,
      previousValue: 150,
    });
    expect(report.dimensions.find((summary) => summary.value === "AI tools")).toMatchObject({
      status: "OK",
      sample: { videos: 3, days: 1, snapshots: 3 },
    });
    expect(llmPort.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        kpis: expect.arrayContaining([expect.objectContaining({ key: "TOTAL_VIEWS" })]),
      }),
    );
  });

  it("keeps deterministic summaries when AI is unconfigured or fails", async () => {
    const current = channelSnapshots(
      ["2026-11-01", "2026-11-02", "2026-11-03"],
      1,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const previous = channelSnapshots(
      ["2026-10-29", "2026-10-30", "2026-10-31"],
      0.5,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const notConfigured = await service(
      database(),
      analytics(current, previous, videoSnapshots()),
      publishing(),
      llm(false),
    ).generateInsightReport(ownerContext, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });
    expect(notConfigured).toMatchObject({ status: "GENERATED", aiStatus: "NOT_CONFIGURED" });
    expect(notConfigured.narrative).toBeNull();
    expect(notConfigured.limitations.join(" ")).toContain("not configured");

    const failed = await service(
      database(),
      analytics(current, previous, videoSnapshots()),
      publishing(),
      llm(true, true),
    ).generateInsightReport(ownerContext, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });
    expect(failed).toMatchObject({ status: "GENERATED", aiStatus: "NOT_GENERATED" });
    expect(failed.narrative).toBeNull();
    expect(failed.limitations.join(" ")).toContain("failed");
  });

  it("normalizes dimension views by exposure days for videos of different ages", async () => {
    const db = database();
    const baseRecords = publishedRecords();
    const publishedAt = [
      "2026-10-30T10:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-03T10:00:00.000Z",
    ] as const;
    const records = baseRecords.map((record, index) => ({
      ...record,
      publishedAt: publishedAt[index]!,
    }));
    const snapshots = [
      snapshot("views", 300, {
        granularity: "VIDEO",
        remoteEntityId: videoIds[0],
        day: "2026-11-01",
        id: "88888888-8888-4888-8888-888888888801",
      }),
      snapshot("views", 300, {
        granularity: "VIDEO",
        remoteEntityId: videoIds[0],
        day: "2026-11-02",
        id: "88888888-8888-4888-8888-888888888802",
      }),
      snapshot("views", 300, {
        granularity: "VIDEO",
        remoteEntityId: videoIds[0],
        day: "2026-11-03",
        id: "88888888-8888-4888-8888-888888888803",
      }),
      snapshot("views", 100, {
        granularity: "VIDEO",
        remoteEntityId: videoIds[1],
        day: "2026-11-02",
        id: "88888888-8888-4888-8888-888888888804",
      }),
      snapshot("views", 200, {
        granularity: "VIDEO",
        remoteEntityId: videoIds[2],
        day: "2026-11-03",
        id: "88888888-8888-4888-8888-888888888805",
      }),
    ];

    const report = await service(
      db,
      analytics([], [], snapshots),
      publishing(records, publishedContexts()),
    ).generateInsightReport(ownerContext, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });

    const summary = report.dimensions.find(
      (dimension) => dimension.dimension === "TOPIC" && dimension.value === "AI tools",
    );
    expect(summary).toMatchObject({
      status: "OK",
      totalViews: 1200,
      exposureDays: 5,
      averageViewsPerVideoDay: 240,
      sample: { videos: 3, days: 3, snapshots: 5 },
    });
  });

  it("ranks recommendations by lift against a multi-bucket dimension baseline", async () => {
    const db = database();
    db.performanceInsightReport.findUnique.mockResolvedValue(
      reportRecord({
        dimensionSummaries: [
          dimensionSummary({
            dimension: "TOPIC",
            value: "AI tools",
            totalViews: 5000,
            exposureDays: 10,
            averageViewsPerVideoDay: 500,
            sample: { videos: 10, days: 10, snapshots: 20 },
          }),
          dimensionSummary({
            dimension: "TOPIC",
            value: "Gaming",
            totalViews: 2500,
            exposureDays: 10,
            averageViewsPerVideoDay: 250,
            sample: { videos: 10, days: 10, snapshots: 20 },
          }),
          dimensionSummary({
            dimension: "HOOK",
            value: "Question",
            totalViews: 2400,
            exposureDays: 8,
            averageViewsPerVideoDay: 300,
            sample: { videos: 8, days: 8, snapshots: 16 },
          }),
          dimensionSummary({
            dimension: "HOOK",
            value: "Statement",
            totalViews: 1600,
            exposureDays: 8,
            averageViewsPerVideoDay: 200,
            sample: { videos: 8, days: 8, snapshots: 16 },
          }),
          dimensionSummary({
            dimension: "CHARACTER",
            value: "Nova",
            totalViews: 2250,
            exposureDays: 6,
            averageViewsPerVideoDay: 375,
            sample: { videos: 6, days: 6, snapshots: 12 },
          }),
          dimensionSummary({
            dimension: "CHARACTER",
            value: "Rex",
            totalViews: 1800,
            exposureDays: 6,
            averageViewsPerVideoDay: 300,
            sample: { videos: 6, days: 6, snapshots: 12 },
          }),
          dimensionSummary({
            dimension: "DURATION",
            value: "60_TO_180S",
            totalViews: 900,
            exposureDays: 3,
            averageViewsPerVideoDay: 300,
            sample: { videos: 3, days: 3, snapshots: 6 },
          }),
          dimensionSummary({
            dimension: "SERIES",
            value: "UNKNOWN",
            status: "INSUFFICIENT_DATA",
            sample: { videos: 2, days: 0, snapshots: 0 },
            totalViews: null,
            exposureDays: 0,
            averageViewsPerVideoDay: null,
          }),
        ],
      }),
    );

    const recommendations = await service(db).generateRecommendations(ownerContext, reportId);
    expect(recommendations.map((item) => [item.dimension, item.confidence])).toEqual([
      ["TOPIC", "MEDIUM"],
      ["HOOK", "MEDIUM"],
      ["CHARACTER", "LOW"],
    ]);
    expect(recommendations[0]).toMatchObject({ rank: 1, status: "PROPOSED", reportId });
    expect(recommendations[0]?.evidenceSnapshotIds.length).toBeGreaterThan(0);
    for (const recommendation of recommendations) {
      expect(recommendation.limitations.length).toBeGreaterThan(0);
      expect(recommendation.limitations.join(" ")).toContain("Correlational");
      expect(recommendation.rationale).toContain("baseline");
      expect(recommendation.rationale).toContain("lift");
    }
    expect(db.performanceRecommendation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId,
          channelId,
          reportId,
          createdByUserId: userId,
        }),
      }),
    );
  });

  it("does not recommend from a dimension with only one OK bucket", async () => {
    const db = database();
    db.performanceInsightReport.findUnique.mockResolvedValue(
      reportRecord({
        dimensionSummaries: [
          dimensionSummary({
            dimension: "TOPIC",
            value: "AI tools",
            totalViews: 5000,
            exposureDays: 10,
            averageViewsPerVideoDay: 500,
            sample: { videos: 10, days: 10, snapshots: 20 },
          }),
        ],
      }),
    );

    const recommendations = await service(db).generateRecommendations(ownerContext, reportId);
    expect(recommendations).toEqual([]);
    expect(db.performanceRecommendation.create).not.toHaveBeenCalled();
  });

  it("requires an editor and an existing report before generating recommendations", async () => {
    await expect(
      service(database()).generateRecommendations(viewerContext, reportId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service(database()).generateRecommendations(ownerContext, reportId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service(database()).approveRecommendation(viewerContext, recommendationId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns existing recommendations without creating duplicates", async () => {
    const db = database();
    db.performanceInsightReport.findUnique.mockResolvedValue(reportRecord());
    db.performanceRecommendation.findMany.mockResolvedValue([
      {
        id: recommendationId,
        workspaceId,
        channelId,
        reportId,
        rank: 1,
        dimension: "TOPIC",
        action: "Prioritize AI tools",
        rationale: "Evidence",
        confidence: "MEDIUM",
        limitations: ["Correlational evidence"],
        evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
        status: "PROPOSED",
        approvedAt: null,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      },
    ]);
    const result = await service(db).generateRecommendations(ownerContext, reportId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: recommendationId, status: "PROPOSED" });
    expect(db.performanceRecommendation.create).not.toHaveBeenCalled();
  });

  it("records experiments with a hypothesis, variant, exposure, and outcome", async () => {
    const db = database();
    const experiment = await service(db).createExperiment(ownerContext, {
      channelId,
      hypothesis: "A question hook lifts retention",
      variant: "Question hook",
      dimensions: ["HOOK"],
      designNotes: "Run for two weeks against the current hook",
      exposure: 100,
    });
    expect(experiment).toMatchObject({
      hypothesis: "A question hook lifts retention",
      variant: "Question hook",
      dimensions: ["HOOK"],
      exposure: 100,
      status: "DRAFT",
    });

    db.performanceExperiment.findUnique
      .mockResolvedValueOnce({
        id: experimentId,
        workspaceId,
        channelId,
        status: "DRAFT",
        exposure: null,
      })
      .mockResolvedValueOnce({
        id: experimentId,
        workspaceId,
        channelId,
        hypothesis: "A question hook lifts retention",
        variant: "Question hook",
        dimensions: ["HOOK"],
        designNotes: "Run for two weeks against the current hook",
        status: "COMPLETED",
        exposure: 250,
        outcome: { viewsLiftPercent: 12 },
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      });
    const completed = await service(db).recordExperimentOutcome(ownerContext, experimentId, {
      outcome: { viewsLiftPercent: 12 },
      exposure: 250,
    });
    expect(completed).toMatchObject({
      status: "COMPLETED",
      exposure: 250,
      outcome: { viewsLiftPercent: 12 },
    });
    expect(db.performanceExperiment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId,
          id: experimentId,
          status: { in: ["DRAFT", "RUNNING"] },
        },
      }),
    );
  });

  it("requires exposure and an open experiment before recording an outcome", async () => {
    const db = database();
    db.performanceExperiment.findUnique.mockResolvedValue({
      id: experimentId,
      workspaceId,
      channelId,
      status: "DRAFT",
      exposure: null,
    });
    await expect(
      service(db).recordExperimentOutcome(ownerContext, experimentId, {
        outcome: { viewsLiftPercent: 4 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.performanceExperiment.updateMany).not.toHaveBeenCalled();

    db.performanceExperiment.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service(db).recordExperimentOutcome(ownerContext, experimentId, {
        outcome: { viewsLiftPercent: 4 },
        exposure: 50,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects multi-dimension experiments without documented design", async () => {
    const db = database();
    await expect(
      service(db).createExperiment(ownerContext, {
        channelId,
        hypothesis: "Change hook and duration",
        variant: "Both",
        dimensions: ["HOOK", "DURATION"],
        designNotes: "",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.performanceExperiment.create).not.toHaveBeenCalled();
  });

  it("approves a proposed recommendation with a compare-and-swap", async () => {
    const db = database();
    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      reportId,
      rank: 1,
      dimension: "TOPIC",
      action: "Prioritize topic",
      rationale: "Evidence",
      confidence: "MEDIUM",
      limitations: [],
      evidenceSnapshotIds: [],
      status: "APPROVED",
      approvedAt: new Date("2026-11-10T00:00:00.000Z"),
      createdAt: new Date("2026-11-10T00:00:00.000Z"),
    });
    const approved = await service(db).approveRecommendation(ownerContext, recommendationId);
    expect(approved.status).toBe("APPROVED");
    expect(db.performanceRecommendation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, id: recommendationId, status: "PROPOSED" },
        data: expect.objectContaining({ status: "APPROVED", approvedByUserId: userId }),
      }),
    );
  });

  it("returns 409 when a recommendation is approved concurrently or already approved", async () => {
    const db = database();
    db.performanceRecommendation.updateMany.mockResolvedValue({ count: 0 });
    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      status: "APPROVED",
    });
    await expect(
      service(db).approveRecommendation(ownerContext, recommendationId),
    ).rejects.toBeInstanceOf(ConflictException);

    db.performanceRecommendation.findUnique.mockResolvedValue(null);
    await expect(
      service(db).approveRecommendation(ownerContext, recommendationId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires approval before exporting a versioned strategy change", async () => {
    const db = database();
    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      dimension: "TOPIC",
      action: "Prioritize AI tools",
      confidence: "HIGH",
      limitations: [],
      evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
      status: "PROPOSED",
    });
    await expect(
      service(db).exportStrategyChange(ownerContext, { recommendationId }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.performanceStrategyChange.create).not.toHaveBeenCalled();

    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      dimension: "TOPIC",
      action: "Prioritize AI tools",
      confidence: "HIGH",
      limitations: [],
      evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
      status: "APPROVED",
    });
    db.performanceStrategyChange.findFirst.mockResolvedValue({ version: 2 });
    const change = await service(db).exportStrategyChange(ownerContext, {
      recommendationId,
      summary: "Adopt AI tools as the primary topic",
    });
    expect(change).toMatchObject({
      channelId,
      version: 3,
      recommendationId,
      summary: "Adopt AI tools as the primary topic",
      status: "APPROVED",
    });
    expect(db.performanceStrategyChange.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId, channelId, version: 3 }),
      }),
    );
  });

  it("returns the existing strategy change on re-export instead of creating a duplicate", async () => {
    const db = database();
    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      dimension: "TOPIC",
      action: "Prioritize AI tools",
      confidence: "HIGH",
      limitations: [],
      evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
      status: "APPROVED",
    });
    db.performanceStrategyChange.findUnique.mockResolvedValue({
      id: strategyChangeId,
      workspaceId,
      channelId,
      version: 1,
      recommendationId,
      summary: "Adopt AI tools as the primary topic",
      changes: {},
      evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
      status: "APPROVED",
      approvedAt: new Date("2026-11-10T00:00:00.000Z"),
      createdAt: new Date("2026-11-10T00:00:00.000Z"),
    });
    const change = await service(db).exportStrategyChange(ownerContext, { recommendationId });
    expect(change).toMatchObject({ version: 1, recommendationId });
    expect(db.performanceStrategyChange.create).not.toHaveBeenCalled();
  });
});
