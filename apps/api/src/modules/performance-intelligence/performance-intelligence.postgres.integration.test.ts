import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { LatestMetricSnapshot } from "@reelforge/contracts";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PerformanceIntelligenceService } from "./performance-intelligence.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const channelId = randomUUID();
const otherChannelId = randomUUID();
const accountId = randomUUID();

const metricKeys = [
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const;

const videoIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
];

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

function snapshot(
  key: (typeof metricKeys)[number],
  value: number,
  day: string,
  remoteEntityId: string | null = null,
): LatestMetricSnapshot {
  return {
    id: randomUUID(),
    key,
    value,
    unit: key === "estimatedMinutesWatched" ? "MINUTES" : "COUNT",
    entityGranularity: remoteEntityId === null ? "CHANNEL" : "VIDEO",
    remoteEntityId,
    periodStart: day,
    periodEnd: day,
    collectedAt: `${day}T06:00:00.000Z`,
    sourceApi: "fixture",
    completeness: "COMPLETE",
    availability: "AVAILABLE",
    unavailableReason: null,
  };
}

function channelSnapshots(days: readonly string[], multiplier: number): LatestMetricSnapshot[] {
  const result: LatestMetricSnapshot[] = [];
  for (const day of days) {
    for (const key of metricKeys) {
      const base = {
        views: 100,
        likes: 10,
        comments: 4,
        shares: 2,
        estimatedMinutesWatched: 50,
        subscribersGained: 5,
        subscribersLost: 1,
      }[key];
      result.push(snapshot(key, base * multiplier, day));
    }
  }
  return result;
}

function videoSnapshots(): LatestMetricSnapshot[] {
  return videoIds.map((videoId, index) =>
    snapshot("views", 300 + index * 100, "2026-11-02", videoId),
  );
}

function publishedRecords(): PublishedRecordFixture[] {
  return videoIds.map((videoId, index) => ({
    workspaceId,
    channelId,
    scheduledPostId: randomUUID(),
    destinationId: randomUUID(),
    publishJobId: randomUUID(),
    renderJobId: randomUUID(),
    accountId,
    platform: "YOUTUBE" as const,
    platformPostId: videoId,
    publishedAt: index < 3 ? "2026-11-01T10:00:00.000Z" : "2026-11-02T10:00:00.000Z",
  }));
}

function publishedContexts(records: PublishedRecordFixture[]): PublishedContextFixture[] {
  return records.map((record, index) => ({
    scheduledPostId: record.scheduledPostId,
    channelId,
    renderJobId: record.renderJobId,
    topic: index < 3 ? "AI tools" : "Gaming",
    hook: index < 3 ? "Question" : "Statement",
    seriesId: null,
    seriesName: index < 3 ? "AI series" : "Gaming series",
    characterNames: index < 3 ? ["Nova"] : ["Rex"],
    durationSeconds: index < 3 ? 120 : 300,
  }));
}

suite("M15 PostgreSQL persistence", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const records = publishedRecords();
  const analytics = {
    listLatestSnapshots: async (
      _context: unknown,
      query: { granularity: "CHANNEL" | "VIDEO"; startDate: string },
    ): Promise<LatestMetricSnapshot[]> => {
      if (query.granularity === "CHANNEL")
        return query.startDate === "2026-11-01"
          ? channelSnapshots(["2026-11-01", "2026-11-02", "2026-11-03"], 1)
          : channelSnapshots(["2026-10-29", "2026-10-30", "2026-10-31"], 0.5);
      return query.startDate === "2026-11-01" ? videoSnapshots() : [];
    },
  };
  const publishing = {
    listPublishedRecords: async (): Promise<PublishedRecordFixture[]> => records,
    listPublishedPostContexts: async (): Promise<PublishedContextFixture[]> =>
      publishedContexts(records),
  };
  const llm = {
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
    isConfigured: (): boolean => false,
    generate: async (): Promise<never> => {
      throw new Error("not used");
    },
  };

  function service(): PerformanceIntelligenceService {
    return new PerformanceIntelligenceService(
      db as never,
      analytics as never,
      publishing as never,
      llm as never,
    );
  }

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [
        { id: userId, email: `${userId}@m15.integration.invalid` },
        { id: otherUserId, email: `${otherUserId}@m15.integration.invalid` },
      ],
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m15-integration" },
        { id: otherWorkspaceId, name: "other-m15-integration" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId, role: "OWNER" },
        { workspaceId: otherWorkspaceId, userId: otherUserId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        { id: channelId, workspaceId, name: "m15-channel" },
        { id: otherChannelId, workspaceId: otherWorkspaceId, name: "other-m15-channel" },
      ],
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

  it("denies cross-workspace insight generation before persisting anything", async () => {
    if (!db) return;
    await expect(
      service().generateInsightReport(
        { workspaceId: otherWorkspaceId, userId: otherUserId, role: "OWNER" },
        {
          channelId,
          socialAccountId: accountId,
          startDate: "2026-11-01",
          endDate: "2026-11-03",
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const count = await db.performanceInsightReport.count({ where: { channelId } });
    expect(count).toBe(0);
  });

  it("persists evidence-linked reports, approvals, and versioned strategy changes", async () => {
    if (!db) return;
    const context = { workspaceId, userId, role: "OWNER" as const };
    const report = await service().generateInsightReport(context, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });
    expect(report).toMatchObject({
      workspaceId,
      channelId,
      status: "GENERATED",
      aiStatus: "NOT_CONFIGURED",
    });
    expect(report.snapshotIds.length).toBeGreaterThan(0);
    expect(report.kpis.find((kpi) => kpi.key === "TOTAL_VIEWS")).toMatchObject({
      status: "OK",
      value: 300,
    });

    const stored = await db.performanceInsightReport.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: report.id } },
    });
    expect(stored.periodStart.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(stored.snapshotIds.length).toBeGreaterThan(0);

    const recommendations = await service().generateRecommendations(context, report.id);
    expect(recommendations.length).toBeGreaterThan(0);
    const recommendation = recommendations[0]!;
    expect(recommendation).toMatchObject({ reportId: report.id, status: "PROPOSED" });

    await expect(
      service().exportStrategyChange(context, { recommendationId: recommendation.id }),
    ).rejects.toBeInstanceOf(ConflictException);

    const approved = await service().approveRecommendation(context, recommendation.id);
    expect(approved.status).toBe("APPROVED");

    const first = await service().exportStrategyChange(context, {
      recommendationId: recommendation.id,
    });
    expect(first).toMatchObject({
      version: 1,
      status: "APPROVED",
      recommendationId: recommendation.id,
    });
    const second = await service().exportStrategyChange(context, {
      recommendationId: recommendation.id,
      summary: "Second approved version",
    });
    expect(second).toMatchObject({ id: first.id, version: 1 });

    const changes = await db.performanceStrategyChange.findMany({
      where: { workspaceId, channelId },
      orderBy: { version: "asc" },
      select: { version: true, recommendationId: true, status: true },
    });
    expect(changes).toEqual([
      { version: 1, recommendationId: recommendation.id, status: "APPROVED" },
    ]);

    const channel = await db.channel.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: channelId } },
      select: { name: true, automationDefaults: true, approvalPolicy: true },
    });
    expect(channel).toEqual({
      name: "m15-channel",
      automationDefaults: null,
      approvalPolicy: null,
    });
  });

  it("allows only one concurrent approval of the same recommendation", async () => {
    if (!db) return;
    const context = { workspaceId, userId, role: "OWNER" as const };
    const report = await service().generateInsightReport(context, {
      channelId,
      socialAccountId: accountId,
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    });
    const recommendations = await service().generateRecommendations(context, report.id);
    expect(recommendations.length).toBeGreaterThan(0);
    const recommendationId = recommendations[0]!.id;

    const results = await Promise.allSettled([
      service().approveRecommendation(context, recommendationId),
      service().approveRecommendation(context, recommendationId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(ConflictException);

    const stored = await db.performanceRecommendation.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: recommendationId } },
    });
    expect(stored.status).toBe("APPROVED");
  });

  it("persists experiments with hypothesis, variant, exposure, and outcome", async () => {
    if (!db) return;
    const context = { workspaceId, userId, role: "OWNER" as const };
    const experiment = await service().createExperiment(context, {
      channelId,
      hypothesis: "Question hooks lift retention",
      variant: "Question hook",
      dimensions: ["HOOK"],
      designNotes: "Two-week controlled comparison",
      exposure: 120,
    });
    expect(experiment).toMatchObject({ status: "DRAFT", exposure: 120 });

    const completed = await service().recordExperimentOutcome(context, experiment.id, {
      outcome: { viewsLiftPercent: 8.5 },
      exposure: 400,
    });
    expect(completed).toMatchObject({
      status: "COMPLETED",
      exposure: 400,
      outcome: { viewsLiftPercent: 8.5 },
    });

    const stored = await db.performanceExperiment.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId, id: experiment.id } },
    });
    expect(stored).toMatchObject({
      hypothesis: "Question hooks lift retention",
      variant: "Question hook",
      exposure: 400,
      status: "COMPLETED",
    });

    await expect(
      service().recordExperimentOutcome(context, experiment.id, {
        outcome: { viewsLiftPercent: 9 },
        exposure: 500,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const missingExposure = await service().createExperiment(context, {
      channelId,
      hypothesis: "A shorter hook improves retention",
      variant: "Three-second hook",
      dimensions: ["HOOK"],
      designNotes: "Two-week controlled comparison",
    });
    await expect(
      service().recordExperimentOutcome(context, missingExposure.id, {
        outcome: { viewsLiftPercent: 3 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
