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
  seriesName: null;
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
  performanceInsightReport: { create: MockMethod; findUnique: MockMethod; findMany: MockMethod };
  performanceRecommendation: {
    create: MockMethod;
    findUnique: MockMethod;
    findMany: MockMethod;
    update: MockMethod;
  };
  performanceExperiment: {
    create: MockMethod;
    findUnique: MockMethod;
    findMany: MockMethod;
    update: MockMethod;
  };
  performanceStrategyChange: { create: MockMethod; findFirst: MockMethod; findMany: MockMethod };
};

function database(): MockDatabase {
  return {
    channel: { findUnique: vi.fn().mockResolvedValue({ id: channelId }) },
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
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
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
        status: data["status"] ?? "APPROVED",
        approvedAt: data["approvedAt"] ?? null,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
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
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: experimentId,
        workspaceId,
        channelId,
        hypothesis: "A better hook lifts retention",
        variant: "Question hook",
        dimensions: ["HOOK"],
        designNotes: "Run for two weeks",
        exposure: data["exposure"] ?? 100,
        outcome: data["outcome"] ?? null,
        status: data["status"] ?? "COMPLETED",
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
        updatedAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
    },
    performanceStrategyChange: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: strategyChangeId,
        ...data,
        createdAt: new Date("2026-11-10T00:00:00.000Z"),
      })),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
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
): PerformanceIntelligenceService {
  return new PerformanceIntelligenceService(
    db as never,
    analyticsPort as never,
    publishingPort as never,
    llmPort as never,
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
    averageViewsPerVideo: 400,
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

  it("ranks recommendations with confidence and evidence from an OK report", async () => {
    const db = database();
    db.performanceInsightReport.findUnique.mockResolvedValue(
      reportRecord({
        dimensionSummaries: [
          dimensionSummary({ dimension: "TOPIC", value: "AI tools", averageViewsPerVideo: 500 }),
          dimensionSummary({
            dimension: "HOOK",
            value: "Question",
            averageViewsPerVideo: 300,
            sample: { videos: 6, days: 8, snapshots: 24 },
          }),
          dimensionSummary({
            dimension: "DURATION",
            value: "60_TO_180S",
            averageViewsPerVideo: 100,
            sample: { videos: 3, days: 2, snapshots: 9 },
          }),
          dimensionSummary({ dimension: "SERIES", value: "UNKNOWN", status: "INSUFFICIENT_DATA" }),
        ],
      }),
    );

    const recommendations = await service(db).generateRecommendations(ownerContext, reportId);
    expect(recommendations).toHaveLength(3);
    expect(recommendations.map((item) => [item.dimension, item.confidence])).toEqual([
      ["TOPIC", "HIGH"],
      ["HOOK", "MEDIUM"],
      ["DURATION", "LOW"],
    ]);
    expect(recommendations[0]).toMatchObject({ rank: 1, status: "PROPOSED", reportId });
    expect(recommendations[0]?.evidenceSnapshotIds.length).toBeGreaterThan(0);
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

  it("requires an editor and an existing report before generating recommendations", async () => {
    await expect(
      service(database()).generateRecommendations(viewerContext, reportId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service(database()).generateRecommendations(ownerContext, reportId),
    ).rejects.toBeInstanceOf(NotFoundException);
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

    db.performanceExperiment.findUnique.mockResolvedValue({
      id: experimentId,
      workspaceId,
      channelId,
      status: "DRAFT",
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

  it("records approval before a recommendation can be applied", async () => {
    const db = database();
    db.performanceRecommendation.findUnique.mockResolvedValue({
      id: recommendationId,
      workspaceId,
      channelId,
      status: "PROPOSED",
    });
    const approved = await service(db).approveRecommendation(ownerContext, recommendationId);
    expect(approved.status).toBe("APPROVED");
    expect(db.performanceRecommendation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId, id: recommendationId } },
        data: expect.objectContaining({ status: "APPROVED", approvedByUserId: userId }),
      }),
    );
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
});
