import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { LatestMetricSnapshot } from "@reelforge/contracts";
import { Prisma } from "@reelforge/database";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { ChannelService } from "../channel/channel.service.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import { PerformanceIntelligenceService } from "../performance-intelligence/performance-intelligence.service.js";
import { PublishingService } from "../publishing/publishing.service.js";
import { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import { buildNotificationLink } from "./notifications.links.js";
import {
  NOTIFICATIONS_CLOCK,
  NOTIFICATIONS_CONFIG,
  type NotificationsConfig,
} from "./notifications.ports.js";
import { NotificationsService } from "./notifications.service.js";
import {
  parseGenerateReport,
  parseListReportsQuery,
  parseUuid,
} from "./notifications.validation.js";
import {
  isValidTimeZone,
  lastCompletedPeriod,
  periodDates,
  reportPeriod,
  type ReportPeriod,
  type ReportPeriodType,
} from "./reports.periods.js";

export const CHANNEL_REPORT_SCHEMA_VERSION = 1;

/** Read-only system context for scheduled reports; it never authorizes a write. */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PUBLISHED_PAGE_SIZE = 100;
const PUBLISHED_MAX_PAGES = 50;
const FAILURE_LIST_LIMIT = 200;
const INSIGHT_REPORT_LIMIT = 50;
const RECOMMENDATION_LIMIT = 100;
const editorRoles = new Set(["OWNER", "EDITOR"]);

export type SectionStatus = "AVAILABLE" | "PARTIAL" | "NO_DATA" | "UNAVAILABLE";

export type MissingDataItem = Readonly<{ section: string; code: string; detail: string }>;

type PublishedPostItem = Readonly<{
  scheduledPostId: string;
  destinationId: string;
  platform: string;
  platformPostId: string;
  publishedAt: string;
  link: string;
}>;

type PublishFailureItem = Readonly<{
  scheduledPostId: string | null;
  failureCode: string | null;
  occurredAt: string;
  link: string | null;
}>;

type MetricsAccountItem = Readonly<{
  socialAccountId: string;
  platform: string;
  daysWithData: number;
  missingDates: readonly string[];
  /** Sum over the period; null unless every day in the period has a persisted value. */
  totals: Readonly<Record<string, number | null>>;
  completeness: readonly string[];
  snapshotIds: readonly string[];
}>;

export type ChannelReportData = Readonly<{
  schemaVersion: number;
  channel: Readonly<{ id: string; name: string; timezone: string }>;
  period: Readonly<{
    type: ReportPeriodType;
    localStartDate: string;
    localEndDate: string;
    start: string;
    end: string;
    timezone: string;
  }>;
  sources: readonly string[];
  publishing: Readonly<{
    status: SectionStatus;
    publishedCount: number | null;
    posts: readonly PublishedPostItem[];
    /** Exact count of PublishFailed events in the period; null only if it could not be read. */
    failedCount: number | null;
    /** Oldest first, at most FAILURE_LIST_LIMIT; PUBLISH_FAILURES_TRUNCATED marks a cut list. */
    failures: readonly PublishFailureItem[];
  }>;
  metrics: Readonly<{ status: SectionStatus; accounts: readonly MetricsAccountItem[] }>;
  insights: Readonly<{
    status: SectionStatus;
    /** Exact totals in the period; the lists below are capped (see *_TRUNCATED missing data). */
    reportCount: number | null;
    recommendationCount: number | null;
    reports: ReadonlyArray<{ id: string; status: string; createdAt: string; link: string }>;
    recommendations: ReadonlyArray<{
      id: string;
      action: string;
      confidence: string;
      status: string;
      createdAt: string;
    }>;
  }>;
  workflow: Readonly<{
    status: SectionStatus;
    completedRuns: number;
    byState: Readonly<Record<string, number>>;
    failedRuns: ReadonlyArray<{ runId: string; link: string }>;
  }>;
}>;

export type ChannelReportView = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string;
  periodType: ReportPeriodType;
  localStartDate: string;
  localEndDate: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  trigger: "MANUAL" | "SCHEDULED";
  generatedByUserId: string | null;
  schemaVersion: number;
  data: ChannelReportData;
  missingData: readonly MissingDataItem[];
  link: string;
  createdAt: string;
}>;

export type ReportTickResult = Readonly<{
  generated: number;
  existing: number;
  suppressed: number;
  notDue: number;
  errors: ReadonlyArray<{ channelId: string; periodType: ReportPeriodType; error: string }>;
}>;

export type ReportChannel = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  timezone: string;
}>;

type ReportRecord = Prisma.ChannelReportGetPayload<Record<string, never>>;

function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function within(iso: string, period: ReportPeriod): boolean {
  const time = Date.parse(iso);
  return time >= period.start.getTime() && time < period.end.getTime();
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * M17-T04 channel reports. A report is assembled only from persisted, verified records read
 * through other modules' public services (M13 published records and `PublishFailed` outbox
 * events, M14 metric snapshots, M15 insight reports/recommendations, M16 run outcomes). No LLM
 * is involved and nothing is estimated: a value that is not persisted is `null` and listed in
 * `missingData`.
 */
@Injectable()
export class ChannelReportsService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly channels: ChannelService,
    private readonly publishing: PublishingService,
    private readonly socialAccounts: SocialAccountsService,
    private readonly analytics: AnalyticsService,
    private readonly performance: PerformanceIntelligenceService,
    private readonly orchestration: OrchestrationService,
    private readonly notifications: NotificationsService,
    @Inject(NOTIFICATIONS_CLOCK) private readonly clock: () => Date,
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
  ) {}

  public async list(context: WorkspaceContext, query: unknown): Promise<ChannelReportView[]> {
    const parsed = parseListReportsQuery(query);
    const reports = await this.db.channelReport.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(parsed.channelId === null ? {} : { channelId: parsed.channelId }),
        ...(parsed.periodType === null ? {} : { periodType: parsed.periodType }),
      },
      orderBy: [{ periodStart: "desc" }, { id: "desc" }],
      take: parsed.limit,
    });
    return reports.map((report) => this.present(report));
  }

  public async get(context: WorkspaceContext, reportId: string): Promise<ChannelReportView> {
    const id = parseUuid(reportId, "reportId");
    const report = await this.db.channelReport.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
    });
    if (!report) throw new NotFoundException("Channel report not found");
    return this.present(report);
  }

  /** OWNER/EDITOR. Idempotent: a repeat request for the same period returns the stored report. */
  public async generate(context: WorkspaceContext, body: unknown): Promise<ChannelReportView> {
    if (!editorRoles.has(context.role)) throw new ForbiddenException("Editor permission required");
    const request = parseGenerateReport(body);
    const [channel] = await this.channels.listReportChannels({
      workspaceId: context.workspaceId,
      channelId: request.channelId,
    });
    if (!channel) throw new NotFoundException("Channel not found");
    let period: ReportPeriod;
    try {
      period = reportPeriod(request.periodType, request.periodStartDate, this.timezoneOf(channel));
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
    if (period.end.getTime() > this.clock().getTime())
      throw new BadRequestException("The report period has not ended yet");
    const { report } = await this.generateFor(channel, period, "MANUAL", context.userId);
    return this.present(report);
  }

  /**
   * Scheduled tick: for every ACTIVE channel, generate the last completed daily and weekly report
   * once its period ended at least `reportDelayMs` ago. Paused and archived channels are
   * suppressed. There is no backfill beyond the latest completed period.
   */
  public async runScheduleTick(now: Date = this.clock()): Promise<ReportTickResult> {
    let generated = 0;
    let existing = 0;
    let suppressed = 0;
    let notDue = 0;
    const errors: Array<{ channelId: string; periodType: ReportPeriodType; error: string }> = [];
    for (const channel of await this.channels.listReportChannels()) {
      if (channel.status !== "ACTIVE") {
        suppressed += 1;
        continue;
      }
      for (const periodType of ["DAILY", "WEEKLY"] as const) {
        try {
          const period = lastCompletedPeriod(periodType, now, this.timezoneOf(channel));
          if (period.end.getTime() + this.config.reportDelayMs > now.getTime()) {
            notDue += 1;
            continue;
          }
          const result = await this.generateFor(channel, period, "SCHEDULED", null);
          if (result.created) generated += 1;
          else existing += 1;
        } catch (error) {
          errors.push({ channelId: channel.id, periodType, error: errorMessage(error) });
        }
      }
    }
    return { generated, existing, suppressed, notDue, errors };
  }

  /** Assembles report data from persisted records only. Exposed for tests. */
  public async assemble(
    channel: ReportChannel,
    period: ReportPeriod,
  ): Promise<{ data: ChannelReportData; missingData: MissingDataItem[] }> {
    const context: WorkspaceContext = {
      workspaceId: channel.workspaceId,
      userId: SYSTEM_USER_ID,
      role: "VIEWER",
    };
    const missing: MissingDataItem[] = [];
    const publishing = await this.publishingSection(context, channel, period, missing);
    const metrics = await this.metricsSection(context, channel, period, missing);
    const insights = await this.insightsSection(context, channel, period, missing);
    const workflow = await this.workflowSection(context, channel, period, missing);
    return {
      data: {
        schemaVersion: CHANNEL_REPORT_SCHEMA_VERSION,
        channel: { id: channel.id, name: channel.name, timezone: period.timezone },
        period: {
          type: period.periodType,
          localStartDate: period.localStartDate,
          localEndDate: period.localEndDate,
          start: period.start.toISOString(),
          end: period.end.toISOString(),
          timezone: period.timezone,
        },
        sources: [
          "M13 published records (verified PUBLISHED destinations)",
          "M13 PublishFailed outbox events",
          "M14 latest metric snapshots (CHANNEL granularity)",
          "M15 insight reports and recommendations",
          "M16 workflow run outcomes",
        ],
        publishing,
        metrics,
        insights,
        workflow,
      },
      missingData: missing,
    };
  }

  private async generateFor(
    channel: ReportChannel,
    period: ReportPeriod,
    trigger: "MANUAL" | "SCHEDULED",
    userId: string | null,
  ): Promise<{ report: ReportRecord; created: boolean }> {
    const key = {
      channelId_periodType_periodStart: {
        channelId: channel.id,
        periodType: period.periodType,
        periodStart: period.start,
      },
    };
    const existing = await this.db.channelReport.findUnique({ where: key });
    if (existing) return { report: existing, created: false };
    const { data, missingData } = await this.assemble(channel, period);
    let report: ReportRecord;
    try {
      // The report and its CHANNEL_REPORT_READY event commit together (review R2), so a crash
      // between the two can never leave a stored report that was never announced.
      report = await this.db.$transaction(async (tx) => {
        const created = await tx.channelReport.create({
          data: {
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            periodType: period.periodType,
            periodStart: period.start,
            periodEnd: period.end,
            localStartDate: period.localStartDate,
            localEndDate: period.localEndDate,
            timezone: period.timezone,
            trigger,
            generatedByUserId: userId,
            schemaVersion: CHANNEL_REPORT_SCHEMA_VERSION,
            data: data as unknown as Prisma.InputJsonValue,
            missingData: missingData as unknown as Prisma.InputJsonValue,
          },
        });
        await this.notifications.recordEvents(
          [
            {
              workspaceId: created.workspaceId,
              channelId: created.channelId,
              eventType: "CHANNEL_REPORT_READY",
              sourceModule: "M17",
              sourceKey: `m17:channel-report:${created.id}`,
              correlationId: null,
              subjectType: "channel_report",
              subjectId: created.id,
              link: this.link(created),
              payload: {
                reportId: created.id,
                periodType: created.periodType,
                localStartDate: created.localStartDate,
                localEndDate: created.localEndDate,
                missingDataCount: missingData.length,
              },
              occurredAt: created.createdAt,
            },
          ],
          tx,
        );
        return created;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.db.channelReport.findUnique({ where: key });
      if (!raced) throw error;
      return { report: raced, created: false };
    }
    return { report, created: true };
  }

  private async publishingSection(
    context: WorkspaceContext,
    channel: ReportChannel,
    period: ReportPeriod,
    missing: MissingDataItem[],
  ): Promise<ChannelReportData["publishing"]> {
    const posts: PublishedPostItem[] = [];
    let publishedCount: number | null = null;
    let status: SectionStatus = "NO_DATA";
    try {
      let after = new Date(period.start.getTime() - 1).toISOString();
      let afterId = NIL_UUID;
      let complete = false;
      for (let page = 0; page < PUBLISHED_MAX_PAGES && !complete; page += 1) {
        const batch = await this.publishing.listPublishedRecords(
          context,
          after,
          PUBLISHED_PAGE_SIZE,
          afterId,
        );
        for (const record of batch) {
          if (Date.parse(record.publishedAt) >= period.end.getTime()) {
            complete = true;
            break;
          }
          if (record.channelId === channel.id && within(record.publishedAt, period))
            posts.push({
              scheduledPostId: record.scheduledPostId,
              destinationId: record.destinationId,
              platform: record.platform,
              platformPostId: record.platformPostId,
              publishedAt: record.publishedAt,
              link: buildNotificationLink("publishedPost", {
                workspaceId: channel.workspaceId,
                scheduledPostId: record.scheduledPostId,
              }),
            });
        }
        if (batch.length < PUBLISHED_PAGE_SIZE) complete = true;
        const last = batch[batch.length - 1];
        if (last !== undefined) {
          after = last.publishedAt;
          afterId = last.destinationId;
        }
      }
      if (complete) {
        publishedCount = posts.length;
        status = posts.length > 0 ? "AVAILABLE" : "NO_DATA";
      } else {
        status = "PARTIAL";
        missing.push({
          section: "publishing",
          code: "PUBLISHED_RECORDS_TRUNCATED",
          detail: `More than ${PUBLISHED_PAGE_SIZE * PUBLISHED_MAX_PAGES} workspace published records were scanned; the list is incomplete and no total is reported`,
        });
      }
    } catch (error) {
      status = "UNAVAILABLE";
      missing.push({
        section: "publishing",
        code: "PUBLISHED_RECORDS_UNAVAILABLE",
        detail: errorMessage(error),
      });
    }
    const failureWhere = {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      eventType: "PublishFailed",
      occurredAt: { gte: period.start, lt: period.end },
    };
    let failures: PublishFailureItem[] = [];
    let failedCount: number | null = null;
    try {
      const [failureRows, failureTotal] = await Promise.all([
        this.db.outboxEvent.findMany({
          where: failureWhere,
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: FAILURE_LIST_LIMIT,
        }),
        this.db.outboxEvent.count({ where: failureWhere }),
      ]);
      failedCount = failureTotal;
      failures = failureRows.map((row): PublishFailureItem => {
        const payload = jsonRecord(row.payload);
        const postId = typeof payload["postId"] === "string" ? payload["postId"] : null;
        return {
          scheduledPostId: postId,
          failureCode: typeof payload["failureCode"] === "string" ? payload["failureCode"] : null,
          occurredAt: row.occurredAt.toISOString(),
          link:
            postId === null
              ? null
              : buildNotificationLink("publishedPost", {
                  workspaceId: channel.workspaceId,
                  scheduledPostId: postId,
                }),
        };
      });
      if (failureTotal > failures.length) {
        if (status !== "UNAVAILABLE") status = "PARTIAL";
        missing.push({
          section: "publishing",
          code: "PUBLISH_FAILURES_TRUNCATED",
          detail: `${failureTotal} publish failures in the period; only the first ${failures.length} are listed`,
        });
      }
    } catch (error) {
      if (status !== "UNAVAILABLE") status = "PARTIAL";
      missing.push({
        section: "publishing",
        code: "PUBLISH_FAILURES_UNAVAILABLE",
        detail: errorMessage(error),
      });
    }
    return { status, publishedCount, posts, failedCount, failures };
  }

  private async metricsSection(
    context: WorkspaceContext,
    channel: ReportChannel,
    period: ReportPeriod,
    missing: MissingDataItem[],
  ): Promise<ChannelReportData["metrics"]> {
    const dates = periodDates(period);
    let accounts: Array<{ id: string; platform: string }>;
    try {
      accounts = (await this.socialAccounts.list(context)).filter(
        (account) => account.channelId === channel.id && account.platform === "YOUTUBE",
      );
    } catch (error) {
      missing.push({
        section: "metrics",
        code: "SOCIAL_ACCOUNTS_UNAVAILABLE",
        detail: errorMessage(error),
      });
      return { status: "UNAVAILABLE", accounts: [] };
    }
    if (accounts.length === 0) {
      missing.push({
        section: "metrics",
        code: "NO_ANALYTICS_ACCOUNT",
        detail: "No YouTube account is connected to this channel, so no metrics exist",
      });
      return { status: "UNAVAILABLE", accounts: [] };
    }
    const results: MetricsAccountItem[] = [];
    let anyData = false;
    let anyMissing = false;
    for (const account of accounts) {
      let snapshots: LatestMetricSnapshot[];
      try {
        snapshots = await this.analytics.listLatestSnapshots(context, {
          channelId: channel.id,
          socialAccountId: account.id,
          granularity: "CHANNEL",
          startDate: period.localStartDate,
          endDate: period.localEndDate,
        });
      } catch (error) {
        anyMissing = true;
        missing.push({
          section: "metrics",
          code: "METRIC_SNAPSHOTS_UNAVAILABLE",
          detail: `${account.id}: ${errorMessage(error)}`,
        });
        continue;
      }
      const available = snapshots.filter(
        (snapshot) =>
          snapshot.availability === "AVAILABLE" &&
          snapshot.value !== null &&
          snapshot.periodStart >= period.localStartDate &&
          snapshot.periodEnd <= period.localEndDate,
      );
      const keys = [...new Set(snapshots.map((snapshot) => snapshot.key))].sort();
      const totals: Record<string, number | null> = {};
      for (const key of keys) {
        const values = available.filter((snapshot) => snapshot.key === key);
        const days = new Set(values.map((snapshot) => snapshot.periodStart));
        totals[key] = dates.every((date) => days.has(date))
          ? values.reduce((sum, snapshot) => sum + (snapshot.value ?? 0), 0)
          : null;
      }
      const daysWithData = new Set(available.map((snapshot) => snapshot.periodStart));
      const missingDates = dates.filter((date) => !daysWithData.has(date));
      if (daysWithData.size > 0) anyData = true;
      if (missingDates.length > 0 || Object.values(totals).some((value) => value === null)) {
        anyMissing = true;
        missing.push({
          section: "metrics",
          code: daysWithData.size === 0 ? "NO_METRIC_SNAPSHOTS" : "INCOMPLETE_METRIC_SNAPSHOTS",
          detail:
            daysWithData.size === 0
              ? `${account.id}: no persisted metric snapshots for ${period.localStartDate}..${period.localEndDate}`
              : `${account.id}: missing or unavailable metrics (${missingDates.join(", ") || "some metrics"}); affected totals are null`,
        });
      }
      results.push({
        socialAccountId: account.id,
        platform: account.platform,
        daysWithData: daysWithData.size,
        missingDates,
        totals,
        completeness: [...new Set(available.map((snapshot) => snapshot.completeness))].sort(),
        snapshotIds: available.map((snapshot) => snapshot.id),
      });
    }
    const status: SectionStatus = !anyData ? "UNAVAILABLE" : anyMissing ? "PARTIAL" : "AVAILABLE";
    return { status, accounts: results };
  }

  private async insightsSection(
    context: WorkspaceContext,
    channel: ReportChannel,
    period: ReportPeriod,
    missing: MissingDataItem[],
  ): Promise<ChannelReportData["insights"]> {
    try {
      const insights = await this.performance.listChannelInsightsBetween(context, {
        channelId: channel.id,
        from: period.start,
        to: period.end,
        reportLimit: INSIGHT_REPORT_LIMIT,
        recommendationLimit: RECOMMENDATION_LIMIT,
      });
      let truncated = false;
      if (insights.reportTotal > insights.reports.length) {
        truncated = true;
        missing.push({
          section: "insights",
          code: "INSIGHT_REPORTS_TRUNCATED",
          detail: `${insights.reportTotal} insight reports in the period; only the first ${insights.reports.length} are listed`,
        });
      }
      if (insights.recommendationTotal > insights.recommendations.length) {
        truncated = true;
        missing.push({
          section: "insights",
          code: "RECOMMENDATIONS_TRUNCATED",
          detail: `${insights.recommendationTotal} recommendations in the period; only the first ${insights.recommendations.length} are listed`,
        });
      }
      const any = insights.reportTotal > 0 || insights.recommendationTotal > 0;
      return {
        status: truncated ? "PARTIAL" : any ? "AVAILABLE" : "NO_DATA",
        reportCount: insights.reportTotal,
        recommendationCount: insights.recommendationTotal,
        reports: insights.reports.map((report) => ({
          id: report.id,
          status: report.status,
          createdAt: report.createdAt,
          link: buildNotificationLink("analyticsDetail", {
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            reportId: report.id,
          }),
        })),
        recommendations: insights.recommendations.map((item) => ({
          id: item.id,
          action: item.action,
          confidence: item.confidence,
          status: item.status,
          createdAt: item.createdAt,
        })),
      };
    } catch (error) {
      missing.push({
        section: "insights",
        code: "INSIGHTS_UNAVAILABLE",
        detail: errorMessage(error),
      });
      return {
        status: "UNAVAILABLE",
        reportCount: null,
        recommendationCount: null,
        reports: [],
        recommendations: [],
      };
    }
  }

  private async workflowSection(
    context: WorkspaceContext,
    channel: ReportChannel,
    period: ReportPeriod,
    missing: MissingDataItem[],
  ): Promise<ChannelReportData["workflow"]> {
    try {
      const outcomes = await this.orchestration.countRunOutcomes(
        context,
        channel.id,
        period.start,
        period.end,
      );
      const completedRuns = Object.values(outcomes.byState).reduce((sum, count) => sum + count, 0);
      return {
        status: completedRuns > 0 ? "AVAILABLE" : "NO_DATA",
        completedRuns,
        byState: outcomes.byState,
        failedRuns: outcomes.failedRunIds.map((runId) => ({
          runId,
          link: buildNotificationLink("workflowRun", { workspaceId: channel.workspaceId, runId }),
        })),
      };
    } catch (error) {
      missing.push({
        section: "workflow",
        code: "RUN_OUTCOMES_UNAVAILABLE",
        detail: errorMessage(error),
      });
      return { status: "UNAVAILABLE", completedRuns: 0, byState: {}, failedRuns: [] };
    }
  }

  private timezoneOf(channel: ReportChannel): string {
    return isValidTimeZone(channel.timezone) ? channel.timezone : "UTC";
  }

  private link(report: { workspaceId: string; channelId: string; id: string }): string {
    return buildNotificationLink("channelReport", {
      workspaceId: report.workspaceId,
      channelId: report.channelId,
      reportId: report.id,
    });
  }

  private present(report: ReportRecord): ChannelReportView {
    return {
      id: report.id,
      workspaceId: report.workspaceId,
      channelId: report.channelId,
      periodType: report.periodType,
      localStartDate: report.localStartDate,
      localEndDate: report.localEndDate,
      periodStart: report.periodStart.toISOString(),
      periodEnd: report.periodEnd.toISOString(),
      timezone: report.timezone,
      trigger: report.trigger,
      generatedByUserId: report.generatedByUserId,
      schemaVersion: report.schemaVersion,
      data: report.data as unknown as ChannelReportData,
      missingData: report.missingData as unknown as MissingDataItem[],
      link: this.link(report),
      createdAt: report.createdAt.toISOString(),
    };
  }
}
