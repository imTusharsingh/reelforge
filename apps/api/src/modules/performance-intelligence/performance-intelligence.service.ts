import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import {
  PerformanceDimensionSummarySchema,
  PerformanceInsightReportSchema,
  PerformanceKpiResultSchema,
  PerformanceRecommendationSchema,
  PerformanceExperimentSchema,
  PerformanceStrategyChangeSchema,
  type CreateExperimentRequest,
  type ExportStrategyChangeRequest,
  type GenerateInsightReportRequest,
  type InsightReportStatus,
  type LatestMetricSnapshot,
  type MetricCompleteness,
  type PerformanceDimension,
  type PerformanceDimensionSummary,
  type PerformanceExperiment,
  type PerformanceInsightReport,
  type PerformanceKpiDefinition,
  type PerformanceKpiKey,
  type PerformanceKpiResult,
  type PerformanceRecommendation,
  type PerformanceSample,
  type PerformanceStrategyChange,
  type PerformanceWindow,
  type PublishedPostContext,
  type PublishedPostRecord,
  type RecordExperimentOutcomeRequest,
} from "@reelforge/contracts";
import { AnalyticsService } from "../analytics/analytics.service.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { PublishingService } from "../publishing/publishing.service.js";
import {
  INSIGHT_REPORT_LLM,
  type InsightReportLlmPort,
} from "./performance-intelligence.tokens.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const publishedPostPageSize = 100;
const maximumPublishedPostPages = 1_000;
const dimensionMinimumSample: PerformanceSample = { videos: 3, days: 1, snapshots: 3 };
const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export const performanceKpiDefinitions: readonly PerformanceKpiDefinition[] = [
  {
    key: "TOTAL_VIEWS",
    label: "Total views",
    description: "Sum of available view snapshots in the window.",
    unit: "COUNT",
    formula: "sum(views)",
    comparisonWindowDays: 7,
    minimumSample: { videos: 0, days: 1, snapshots: 1 },
  },
  {
    key: "ENGAGEMENT_RATE",
    label: "Engagement rate",
    description: "(likes + comments + shares) divided by views.",
    unit: "RATIO",
    formula: "(likes + comments + shares) / views",
    comparisonWindowDays: 7,
    minimumSample: { videos: 0, days: 3, snapshots: 3 },
  },
  {
    key: "WATCH_MINUTES_PER_VIEW",
    label: "Watch minutes per view",
    description: "Estimated watch minutes divided by views.",
    unit: "MINUTES",
    formula: "estimatedMinutesWatched / views",
    comparisonWindowDays: 7,
    minimumSample: { videos: 0, days: 3, snapshots: 3 },
  },
  {
    key: "NET_SUBSCRIBERS",
    label: "Net subscribers",
    description: "Subscribers gained minus subscribers lost.",
    unit: "COUNT",
    formula: "subscribersGained - subscribersLost",
    comparisonWindowDays: 7,
    minimumSample: { videos: 0, days: 3, snapshots: 3 },
  },
  {
    key: "VIEWS_PER_DAY",
    label: "Views per day",
    description: "Total views divided by the number of days with view data.",
    unit: "COUNT",
    formula: "sum(views) / days",
    comparisonWindowDays: 7,
    minimumSample: { videos: 0, days: 3, snapshots: 3 },
  },
];

type Snapshot = LatestMetricSnapshot;
type VideoPoint = Readonly<{
  record: PublishedPostRecord;
  context: PublishedPostContext | null;
  snapshots: readonly Snapshot[];
}>;

type InsightReportRecord = Prisma.PerformanceInsightReportGetPayload<object>;
type RecommendationRecord = Prisma.PerformanceRecommendationGetPayload<object>;
type ExperimentRecord = Prisma.PerformanceExperimentGetPayload<object>;
type StrategyChangeRecord = Prisma.PerformanceStrategyChangeGetPayload<object>;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function previousWindow(current: PerformanceWindow): PerformanceWindow {
  const days =
    Math.floor(
      (parseDate(current.endDate).getTime() - parseDate(current.startDate).getTime()) /
        dayMilliseconds,
    ) + 1;
  const previousEnd = new Date(parseDate(current.startDate).getTime() - dayMilliseconds);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * dayMilliseconds);
  return { startDate: dateOnly(previousStart), endDate: dateOnly(previousEnd) };
}

function isAvailable(snapshot: Snapshot): snapshot is Snapshot & { value: number } {
  return snapshot.availability === "AVAILABLE" && snapshot.value !== null;
}

function metricSum(snapshots: readonly Snapshot[], key: string): number {
  return snapshots
    .filter((snapshot) => snapshot.key === key && isAvailable(snapshot))
    .reduce((total, snapshot) => total + (snapshot.value as number), 0);
}

function hasMetric(snapshots: readonly Snapshot[], key: string): boolean {
  return snapshots.some((snapshot) => snapshot.key === key && isAvailable(snapshot));
}

function sampleOf(snapshots: readonly Snapshot[]): PerformanceSample {
  const available = snapshots.filter(isAvailable);
  const days = new Set(available.map((snapshot) => snapshot.periodStart));
  const videos = new Set(
    available
      .map((snapshot) => snapshot.remoteEntityId)
      .filter((remoteEntityId): remoteEntityId is string => remoteEntityId !== null),
  );
  return { videos: videos.size, days: days.size, snapshots: available.length };
}

function completenessOf(snapshots: readonly Snapshot[]): MetricCompleteness {
  if (snapshots.length === 0) return "UNAVAILABLE";
  const available = snapshots.filter(isAvailable).length;
  return available === snapshots.length ? "COMPLETE" : available === 0 ? "UNAVAILABLE" : "PARTIAL";
}

function latestCollectedAt(snapshots: readonly Snapshot[]): string | null {
  if (snapshots.length === 0) return null;
  return snapshots.reduce(
    (latest, snapshot) => (snapshot.collectedAt > latest ? snapshot.collectedAt : latest),
    snapshots[0]!.collectedAt,
  );
}

function meetsMinimum(sample: PerformanceSample, minimum: PerformanceSample): boolean {
  return (
    sample.videos >= minimum.videos &&
    sample.days >= minimum.days &&
    sample.snapshots >= minimum.snapshots
  );
}

function kpiValue(key: PerformanceKpiKey, snapshots: readonly Snapshot[]): number | null {
  const views = metricSum(snapshots, "views");
  switch (key) {
    case "TOTAL_VIEWS":
      return hasMetric(snapshots, "views") ? views : null;
    case "ENGAGEMENT_RATE":
      return views > 0
        ? (metricSum(snapshots, "likes") +
            metricSum(snapshots, "comments") +
            metricSum(snapshots, "shares")) /
            views
        : null;
    case "WATCH_MINUTES_PER_VIEW":
      return views > 0 ? metricSum(snapshots, "estimatedMinutesWatched") / views : null;
    case "NET_SUBSCRIBERS":
      return hasMetric(snapshots, "subscribersGained") || hasMetric(snapshots, "subscribersLost")
        ? metricSum(snapshots, "subscribersGained") - metricSum(snapshots, "subscribersLost")
        : null;
    case "VIEWS_PER_DAY": {
      const days = new Set(
        snapshots
          .filter((snapshot) => snapshot.key === "views" && isAvailable(snapshot))
          .map((snapshot) => snapshot.periodStart),
      ).size;
      return days > 0 ? views / days : null;
    }
  }
}

function computeKpi(
  definition: PerformanceKpiDefinition,
  current: readonly Snapshot[],
  previous: readonly Snapshot[],
  currentWindow: PerformanceWindow,
  previousComparison: PerformanceWindow,
): PerformanceKpiResult {
  const sample = sampleOf(current);
  const previousSample = sampleOf(previous);
  const rawValue = kpiValue(definition.key, current);
  const previousMeetsMinimum = meetsMinimum(previousSample, definition.minimumSample);
  const previousValue = previousMeetsMinimum ? kpiValue(definition.key, previous) : null;
  const limitations: string[] = [];
  if (!meetsMinimum(sample, definition.minimumSample))
    limitations.push(
      `Requires at least ${definition.minimumSample.days} days and ${definition.minimumSample.snapshots} available snapshots; found ${sample.days} days and ${sample.snapshots} snapshots.`,
    );
  if (previousValue === null)
    limitations.push("The previous comparison window has insufficient data.");
  const status =
    meetsMinimum(sample, definition.minimumSample) && rawValue !== null
      ? "OK"
      : "INSUFFICIENT_DATA";
  return PerformanceKpiResultSchema.parse({
    key: definition.key,
    status,
    value: status === "OK" ? rawValue : null,
    previousValue,
    changePercent:
      status === "OK" && previousValue !== null && previousValue !== 0
        ? ((rawValue! - previousValue) / Math.abs(previousValue)) * 100
        : null,
    unit: definition.unit,
    currentWindow,
    previousWindow: previousComparison,
    sample,
    minimumSample: definition.minimumSample,
    completeness: completenessOf(current),
    snapshotIds: current.filter(isAvailable).map((snapshot) => snapshot.id),
    collectedAt: latestCollectedAt(current),
    limitations,
  });
}

function durationBucket(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return "LT_60S";
  if (seconds < 180) return "60_TO_180S";
  if (seconds < 600) return "180_TO_600S";
  return "GTE_600S";
}

function publishTimingBucket(publishedAt: string): string {
  return weekdayNames[new Date(publishedAt).getUTCDay()]!;
}

function dimensionBucket(dimension: PerformanceDimension, point: VideoPoint): string | null {
  switch (dimension) {
    case "TOPIC":
      return point.context?.topic ?? null;
    case "HOOK":
      return point.context?.hook ?? null;
    case "SERIES":
      return point.context?.seriesName ?? point.context?.seriesId ?? null;
    case "CHARACTER":
      return point.context === null || point.context.characterNames.length === 0
        ? null
        : [...point.context.characterNames].sort().join(", ");
    case "DURATION":
      return durationBucket(point.context?.durationSeconds ?? null);
    case "PUBLISH_TIMING":
      return publishTimingBucket(point.record.publishedAt);
  }
}

function summarizeDimension(
  dimension: PerformanceDimension,
  value: string,
  points: readonly VideoPoint[],
): PerformanceDimensionSummary {
  const snapshots = points.flatMap((point) => point.snapshots);
  const sample = sampleOf(snapshots);
  const limitations: string[] = [];
  if (!meetsMinimum(sample, dimensionMinimumSample))
    limitations.push(
      `Requires at least ${dimensionMinimumSample.videos} published videos with metrics; found ${sample.videos}.`,
    );
  const status = meetsMinimum(sample, dimensionMinimumSample) ? "OK" : "INSUFFICIENT_DATA";
  const views = metricSum(snapshots, "views");
  const videos = sample.videos;
  return PerformanceDimensionSummarySchema.parse({
    dimension,
    value,
    status,
    sample,
    minimumSample: dimensionMinimumSample,
    totalViews: status === "OK" ? views : null,
    averageViewsPerVideo: status === "OK" && videos > 0 ? views / videos : null,
    engagementRate:
      status === "OK" && views > 0
        ? (metricSum(snapshots, "likes") +
            metricSum(snapshots, "comments") +
            metricSum(snapshots, "shares")) /
          views
        : null,
    watchMinutesPerView:
      status === "OK" && views > 0 ? metricSum(snapshots, "estimatedMinutesWatched") / views : null,
    netSubscribers:
      status === "OK" &&
      (hasMetric(snapshots, "subscribersGained") || hasMetric(snapshots, "subscribersLost"))
        ? metricSum(snapshots, "subscribersGained") - metricSum(snapshots, "subscribersLost")
        : null,
    snapshotIds: snapshots.filter(isAvailable).map((snapshot) => snapshot.id),
    publishedPostIds: [
      ...new Set(
        points
          .filter((point) => point.snapshots.some(isAvailable))
          .map((point) => point.record.scheduledPostId),
      ),
    ],
    limitations,
  });
}

function buildDimensionSummaries(points: readonly VideoPoint[]): PerformanceDimensionSummary[] {
  const dimensions: PerformanceDimension[] = [
    "TOPIC",
    "HOOK",
    "DURATION",
    "CHARACTER",
    "SERIES",
    "PUBLISH_TIMING",
  ];
  const summaries: PerformanceDimensionSummary[] = [];
  for (const dimension of dimensions) {
    const buckets = new Map<string, VideoPoint[]>();
    let unjoined = 0;
    for (const point of points) {
      const bucket = dimensionBucket(dimension, point);
      if (bucket === null) {
        unjoined += 1;
        continue;
      }
      const existing = buckets.get(bucket) ?? [];
      existing.push(point);
      buckets.set(bucket, existing);
    }
    for (const [value, bucketPoints] of buckets)
      summaries.push(summarizeDimension(dimension, value, bucketPoints));
    if (unjoined > 0)
      summaries.push(
        PerformanceDimensionSummarySchema.parse({
          dimension,
          value: "UNKNOWN",
          status: "INSUFFICIENT_DATA",
          sample: { videos: unjoined, days: 0, snapshots: 0 },
          minimumSample: dimensionMinimumSample,
          totalViews: null,
          averageViewsPerVideo: null,
          engagementRate: null,
          watchMinutesPerView: null,
          netSubscribers: null,
          snapshotIds: [],
          publishedPostIds: [],
          limitations: [`${unjoined} published videos could not be joined to this dimension.`],
        }),
      );
  }
  return summaries.sort((left, right) => {
    if (left.dimension !== right.dimension) return left.dimension.localeCompare(right.dimension);
    if (left.status !== right.status) return left.status === "OK" ? -1 : 1;
    return (right.averageViewsPerVideo ?? -1) - (left.averageViewsPerVideo ?? -1);
  });
}

function confidenceFor(sample: PerformanceSample): "LOW" | "MEDIUM" | "HIGH" {
  if (sample.videos >= 10 && sample.days >= 14) return "HIGH";
  if (sample.videos >= 5 && sample.days >= 7) return "MEDIUM";
  return "LOW";
}

@Injectable()
export class PerformanceIntelligenceService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly analytics: AnalyticsService,
    private readonly publishing: PublishingService,
    @Inject(INSIGHT_REPORT_LLM) private readonly llm: InsightReportLlmPort,
  ) {}

  public kpiDefinitions(): readonly PerformanceKpiDefinition[] {
    return performanceKpiDefinitions;
  }

  public async generateInsightReport(
    context: WorkspaceContext,
    input: GenerateInsightReportRequest,
  ): Promise<PerformanceInsightReport> {
    this.requireEditor(context);
    await this.assertChannel(context, input.channelId);
    const currentWindow: PerformanceWindow = {
      startDate: input.startDate,
      endDate: input.endDate,
    };
    const previous = previousWindow(currentWindow);

    const [currentChannel, previousChannel, currentVideo, previousVideo] = await Promise.all([
      this.analytics.listLatestSnapshots(context, {
        channelId: input.channelId,
        socialAccountId: input.socialAccountId,
        startDate: currentWindow.startDate,
        endDate: currentWindow.endDate,
        granularity: "CHANNEL",
      }),
      this.analytics.listLatestSnapshots(context, {
        channelId: input.channelId,
        socialAccountId: input.socialAccountId,
        startDate: previous.startDate,
        endDate: previous.endDate,
        granularity: "CHANNEL",
      }),
      this.analytics.listLatestSnapshots(context, {
        channelId: input.channelId,
        socialAccountId: input.socialAccountId,
        startDate: currentWindow.startDate,
        endDate: currentWindow.endDate,
        granularity: "VIDEO",
      }),
      this.analytics.listLatestSnapshots(context, {
        channelId: input.channelId,
        socialAccountId: input.socialAccountId,
        startDate: previous.startDate,
        endDate: previous.endDate,
        granularity: "VIDEO",
      }),
    ]);

    const currentKpiSnapshots = currentChannel.length > 0 ? currentChannel : currentVideo;
    const previousKpiSnapshots = previousChannel.length > 0 ? previousChannel : previousVideo;
    const kpis = performanceKpiDefinitions.map((definition) =>
      computeKpi(definition, currentKpiSnapshots, previousKpiSnapshots, currentWindow, previous),
    );

    const points = await this.videoPoints(
      context,
      input.channelId,
      input.socialAccountId,
      currentWindow,
      currentVideo,
    );
    const dimensions = buildDimensionSummaries(points);
    const anyOk =
      kpis.some((kpi) => kpi.status === "OK") ||
      dimensions.some((summary) => summary.status === "OK");
    const status: InsightReportStatus = anyOk ? "GENERATED" : "INSUFFICIENT_DATA";

    let narrative: string | null = null;
    let aiStatus: "GENERATED" | "NOT_CONFIGURED" | "NOT_GENERATED" | "INSUFFICIENT_DATA" =
      status === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : "NOT_CONFIGURED";
    let provider: {
      providerId: string;
      modelVersion: string;
      promptVersion: string;
      cost: number | null;
      currency: string | null;
    } | null = null;
    const limitations: string[] = [];
    if (status !== "INSUFFICIENT_DATA" && this.llm.isConfigured()) {
      try {
        const result = await this.llm.generate({
          channelId: input.channelId,
          currentWindow,
          previousWindow: previous,
          kpis,
          dimensions,
        });
        narrative = result.narrative;
        aiStatus = "GENERATED";
        provider = {
          providerId: this.llm.capability.providerId,
          modelVersion: result.provenance.modelVersion,
          promptVersion: result.provenance.promptVersion,
          cost: result.provenance.cost,
          currency: result.provenance.currency ?? null,
        };
      } catch {
        aiStatus = "NOT_GENERATED";
        limitations.push(
          "The AI insight provider failed; only deterministic summaries are included.",
        );
      }
    } else if (status !== "INSUFFICIENT_DATA") {
      limitations.push(
        "AI insight generation is not configured; only deterministic summaries are included.",
      );
    }
    if (status === "INSUFFICIENT_DATA")
      limitations.push(
        "The window does not meet the minimum sample rules; no confident conclusion is reported.",
      );

    const snapshotIds = [
      ...new Set([
        ...kpis.flatMap((kpi) => kpi.snapshotIds),
        ...dimensions.flatMap((summary) => summary.snapshotIds),
      ]),
    ];

    const record = await this.db.performanceInsightReport.create({
      data: {
        workspaceId: context.workspaceId,
        channelId: input.channelId,
        periodStart: parseDate(currentWindow.startDate),
        periodEnd: parseDate(currentWindow.endDate),
        comparisonStart: parseDate(previous.startDate),
        comparisonEnd: parseDate(previous.endDate),
        status,
        kpis: kpis as unknown as Prisma.InputJsonValue,
        dimensionSummaries: dimensions as unknown as Prisma.InputJsonValue,
        narrative,
        aiStatus,
        providerId: provider?.providerId ?? null,
        modelVersion: provider?.modelVersion ?? null,
        promptVersion: provider?.promptVersion ?? null,
        cost: provider?.cost ?? null,
        costCurrency: provider?.currency ?? null,
        limitations: limitations as unknown as Prisma.InputJsonValue,
        snapshotIds,
        createdByUserId: context.userId,
      },
    });
    return this.presentReport(record);
  }

  public async listInsightReports(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<PerformanceInsightReport[]> {
    await this.assertChannel(context, channelId);
    const records = await this.db.performanceInsightReport.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    return records.map((record) => this.presentReport(record));
  }

  public async getInsightReport(
    context: WorkspaceContext,
    reportId: string,
  ): Promise<PerformanceInsightReport> {
    const record = await this.db.performanceInsightReport.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: reportId } },
    });
    if (!record) throw new NotFoundException("Insight report not found");
    return this.presentReport(record);
  }

  public async generateRecommendations(
    context: WorkspaceContext,
    reportId: string,
  ): Promise<PerformanceRecommendation[]> {
    this.requireEditor(context);
    const report = await this.db.performanceInsightReport.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: reportId } },
    });
    if (!report) throw new NotFoundException("Insight report not found");
    const dimensions = PerformanceDimensionSummarySchema.array().parse(report.dimensionSummaries);
    const eligible = dimensions
      .filter((summary) => summary.status === "OK" && summary.value !== "UNKNOWN")
      .sort((left, right) => (right.averageViewsPerVideo ?? 0) - (left.averageViewsPerVideo ?? 0))
      .slice(0, 5);
    if (eligible.length === 0) return [];

    const created: RecommendationRecord[] = [];
    for (const [index, summary] of eligible.entries()) {
      const confidence = confidenceFor(summary.sample);
      const record = await this.db.performanceRecommendation.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: report.channelId,
          reportId: report.id,
          rank: index + 1,
          dimension: summary.dimension,
          action: `Prioritize ${summary.dimension.toLowerCase()} "${summary.value}" — it averaged ${Math.round(summary.averageViewsPerVideo ?? 0)} views per video.`,
          rationale: `Based on ${summary.sample.videos} published videos and ${summary.sample.snapshots} metric snapshots in the report window.`,
          confidence,
          limitations: summary.limitations as unknown as Prisma.InputJsonValue,
          evidenceSnapshotIds: summary.snapshotIds,
          createdByUserId: context.userId,
        },
      });
      created.push(record);
    }
    return created.map((record) => this.presentRecommendation(record));
  }

  public async listRecommendations(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<PerformanceRecommendation[]> {
    await this.assertChannel(context, channelId);
    const records = await this.db.performanceRecommendation.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: [{ createdAt: "desc" }, { rank: "asc" }, { id: "asc" }],
      take: 100,
    });
    return records.map((record) => this.presentRecommendation(record));
  }

  public async approveRecommendation(
    context: WorkspaceContext,
    recommendationId: string,
  ): Promise<PerformanceRecommendation> {
    this.requireEditor(context);
    const existing = await this.db.performanceRecommendation.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: recommendationId },
      },
    });
    if (!existing) throw new NotFoundException("Recommendation not found");
    if (existing.status !== "PROPOSED")
      throw new ConflictException("Only a proposed recommendation can be approved");
    const record = await this.db.performanceRecommendation.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: recommendationId } },
      data: {
        status: "APPROVED",
        approvedByUserId: context.userId,
        approvedAt: new Date(),
      },
    });
    return this.presentRecommendation(record);
  }

  public async createExperiment(
    context: WorkspaceContext,
    input: CreateExperimentRequest,
  ): Promise<PerformanceExperiment> {
    this.requireEditor(context);
    await this.assertChannel(context, input.channelId);
    if (input.dimensions.length > 1 && input.designNotes.trim().length === 0)
      throw new BadRequestException(
        "Experiments that change multiple dimensions require documented design notes",
      );
    const record = await this.db.performanceExperiment.create({
      data: {
        workspaceId: context.workspaceId,
        channelId: input.channelId,
        hypothesis: input.hypothesis,
        variant: input.variant,
        dimensions: input.dimensions,
        designNotes: input.designNotes,
        exposure: input.exposure ?? null,
        createdByUserId: context.userId,
      },
    });
    return this.presentExperiment(record);
  }

  public async recordExperimentOutcome(
    context: WorkspaceContext,
    experimentId: string,
    input: RecordExperimentOutcomeRequest,
  ): Promise<PerformanceExperiment> {
    this.requireEditor(context);
    const existing = await this.db.performanceExperiment.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: experimentId } },
    });
    if (!existing) throw new NotFoundException("Experiment not found");
    const record = await this.db.performanceExperiment.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: experimentId } },
      data: {
        outcome: input.outcome as unknown as Prisma.InputJsonValue,
        exposure: input.exposure ?? existing.exposure,
        status: "COMPLETED",
      },
    });
    return this.presentExperiment(record);
  }

  public async listExperiments(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<PerformanceExperiment[]> {
    await this.assertChannel(context, channelId);
    const records = await this.db.performanceExperiment.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return records.map((record) => this.presentExperiment(record));
  }

  public async exportStrategyChange(
    context: WorkspaceContext,
    input: ExportStrategyChangeRequest,
  ): Promise<PerformanceStrategyChange> {
    this.requireEditor(context);
    const recommendation = await this.db.performanceRecommendation.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: input.recommendationId },
      },
    });
    if (!recommendation) throw new NotFoundException("Recommendation not found");
    if (recommendation.status !== "APPROVED")
      throw new ConflictException("Recommendation must be approved before export");

    const latest = await this.db.performanceStrategyChange.findFirst({
      where: { workspaceId: context.workspaceId, channelId: recommendation.channelId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const now = new Date();
    const record = await this.db.performanceStrategyChange.create({
      data: {
        workspaceId: context.workspaceId,
        channelId: recommendation.channelId,
        version,
        recommendationId: recommendation.id,
        summary: input.summary ?? recommendation.action,
        changes: {
          dimension: recommendation.dimension,
          action: recommendation.action,
          confidence: recommendation.confidence,
          limitations: recommendation.limitations,
        } as unknown as Prisma.InputJsonValue,
        evidenceSnapshotIds: recommendation.evidenceSnapshotIds,
        status: "APPROVED",
        approvedByUserId: context.userId,
        approvedAt: now,
        createdByUserId: context.userId,
      },
    });
    return this.presentStrategyChange(record);
  }

  public async listStrategyChanges(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<PerformanceStrategyChange[]> {
    await this.assertChannel(context, channelId);
    const records = await this.db.performanceStrategyChange.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    return records.map((record) => this.presentStrategyChange(record));
  }

  private async videoPoints(
    context: WorkspaceContext,
    channelId: string,
    socialAccountId: string,
    window: PerformanceWindow,
    snapshots: readonly Snapshot[],
  ): Promise<VideoPoint[]> {
    const records: PublishedPostRecord[] = [];
    let after: string | null = null;
    let afterId: string | null = null;
    for (let page = 0; page < maximumPublishedPostPages; page += 1) {
      const batch = await this.publishing.listPublishedRecords(
        context,
        after,
        publishedPostPageSize,
        afterId,
      );
      records.push(...batch);
      if (batch.length < publishedPostPageSize) break;
      const last = batch[batch.length - 1]!;
      after = last.publishedAt;
      afterId = last.destinationId;
    }
    const start = parseDate(window.startDate).getTime();
    const end = parseDate(window.endDate).getTime() + dayMilliseconds - 1;
    const inWindow = records.filter((record) => {
      if (record.workspaceId !== context.workspaceId) return false;
      if (record.channelId !== channelId || record.accountId !== socialAccountId) return false;
      if (record.platform !== "YOUTUBE") return false;
      const published = new Date(record.publishedAt).getTime();
      return published >= start && published <= end;
    });
    const contexts = await this.publishing.listPublishedPostContexts(
      context,
      inWindow.map((record) => record.scheduledPostId),
    );
    const contextByPost = new Map(contexts.map((item) => [item.scheduledPostId, item]));
    const snapshotsByVideo = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots) {
      if (snapshot.remoteEntityId === null) continue;
      const existing = snapshotsByVideo.get(snapshot.remoteEntityId) ?? [];
      existing.push(snapshot);
      snapshotsByVideo.set(snapshot.remoteEntityId, existing);
    }
    return inWindow.map((record) => ({
      record,
      context: contextByPost.get(record.scheduledPostId) ?? null,
      snapshots: snapshotsByVideo.get(record.platformPostId) ?? [],
    }));
  }

  private async assertChannel(context: WorkspaceContext, channelId: string): Promise<void> {
    const channel = await this.db.channel.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: channelId } },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
  }

  private requireEditor(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException(
        "Editor permission required for performance intelligence actions",
      );
  }

  private presentReport(record: InsightReportRecord): PerformanceInsightReport {
    return PerformanceInsightReportSchema.parse({
      id: record.id,
      workspaceId: record.workspaceId,
      channelId: record.channelId,
      status: record.status,
      currentWindow: {
        startDate: dateOnly(record.periodStart),
        endDate: dateOnly(record.periodEnd),
      },
      previousWindow: {
        startDate: dateOnly(record.comparisonStart),
        endDate: dateOnly(record.comparisonEnd),
      },
      kpis: record.kpis,
      dimensions: record.dimensionSummaries,
      narrative: record.narrative,
      aiStatus: record.aiStatus,
      provider:
        record.providerId === null
          ? null
          : {
              providerId: record.providerId,
              modelVersion: record.modelVersion ?? "unknown",
              promptVersion: record.promptVersion ?? "unknown",
              cost: record.cost === null ? null : Number(record.cost),
              currency: record.costCurrency,
            },
      limitations: record.limitations,
      snapshotIds: record.snapshotIds,
      createdAt: record.createdAt.toISOString(),
    });
  }

  private presentRecommendation(record: RecommendationRecord): PerformanceRecommendation {
    return PerformanceRecommendationSchema.parse({
      id: record.id,
      workspaceId: record.workspaceId,
      channelId: record.channelId,
      reportId: record.reportId,
      rank: record.rank,
      dimension: record.dimension,
      action: record.action,
      rationale: record.rationale,
      confidence: record.confidence,
      limitations: record.limitations,
      evidenceSnapshotIds: record.evidenceSnapshotIds,
      status: record.status,
      approvedAt: record.approvedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    });
  }

  private presentExperiment(record: ExperimentRecord): PerformanceExperiment {
    return PerformanceExperimentSchema.parse({
      id: record.id,
      workspaceId: record.workspaceId,
      channelId: record.channelId,
      hypothesis: record.hypothesis,
      variant: record.variant,
      dimensions: record.dimensions,
      designNotes: record.designNotes,
      exposure: record.exposure,
      outcome: record.outcome,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  private presentStrategyChange(record: StrategyChangeRecord): PerformanceStrategyChange {
    return PerformanceStrategyChangeSchema.parse({
      id: record.id,
      workspaceId: record.workspaceId,
      channelId: record.channelId,
      version: record.version,
      recommendationId: record.recommendationId,
      summary: record.summary,
      changes: record.changes,
      evidenceSnapshotIds: record.evidenceSnapshotIds,
      status: record.status,
      approvedAt: record.approvedAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
    });
  }
}
