import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AnalyticsMetricDefinitionSchema,
  MetricAggregateSchema,
  NormalizedMetricValueSchema,
  SocialPlatformErrorSchema,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  type MetricAggregate,
  type MetricCompleteness,
  type NormalizedMetricValue,
  type PublishedPostRecord,
  type SocialPlatformError,
  type YouTubeAnalyticsReport,
} from "@reelforge/contracts";
import { SocialProviderError } from "@reelforge/social-providers";
import type { Database } from "../identity/identity.types.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import {
  YOUTUBE_ANALYTICS_READ_SCOPE,
  YOUTUBE_ANALYTICS_SOURCE_API,
  youtubeMetricCatalog,
  youtubeMetricKeysFor,
  youtubeMetricUnit,
} from "./analytics.catalog.js";
import {
  ANALYTICS_YOUTUBE_CLIENT,
  AnalyticsConnectorUnavailableError,
  PUBLISHED_POST_SOURCE,
  type PublishedPostSource,
  type YouTubeAnalyticsClient,
} from "./analytics.tokens.js";
import { retryDecision } from "./analytics.retry.js";
import type { MetricAggregateQuery } from "./analytics.validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const dayMilliseconds = 24 * 60 * 60 * 1000;
const publishedPostPageSize = 100;
const maximumPublishedPostPages = 1_000;
const maximumCollectionRetries = 5;
const videoFilterBatchSize = 500;

type CollectionFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
}>;

type CollectionEntity = Readonly<{
  remoteEntityId: string | null;
  startDate: string;
}>;

export type MetricCollectionResult = Readonly<{
  jobId: string;
  runId: string;
  status: "SUCCEEDED" | "RETRY_WAIT" | "FAILED_FINAL";
  snapshotCount: number;
  completeness: MetricCompleteness | null;
  retryCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
}>;

function numericMetricValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function collectionFailure(error: unknown): CollectionFailure {
  if (error instanceof SocialProviderError) return providerFailure(error.detail);
  if (error instanceof HttpException) {
    const parsed = SocialPlatformErrorSchema.safeParse(error.getResponse());
    if (parsed.success) return providerFailure(parsed.data);
    return {
      code: `HTTP_${error.getStatus()}`,
      message: error.message,
      retryable: false,
      retryAfterSeconds: null,
    };
  }
  if (error instanceof AnalyticsConnectorUnavailableError)
    return {
      code: "ANALYTICS_NOT_CONFIGURED",
      message: error.message,
      retryable: false,
      retryAfterSeconds: null,
    };
  return {
    code: "COLLECTION_FAILED",
    message: "Metric collection failed.",
    retryable: false,
    retryAfterSeconds: null,
  };
}

function providerFailure(detail: SocialPlatformError): CollectionFailure {
  const code = detail.code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "PROVIDER_FAILURE";
  return {
    code,
    message: detail.message,
    retryable: detail.kind === "RATE_LIMITED" || detail.kind === "TRANSIENT",
    retryAfterSeconds: detail.retryAfterSeconds,
  };
}

function calendarDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  for (
    let current = Date.parse(`${startDate}T00:00:00.000Z`);
    current <= end;
    current += dayMilliseconds
  )
    dates.push(dateOnly(new Date(current)));
  return dates;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function calendarDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / dayMilliseconds) + 1;
}

@Injectable()
export class AnalyticsService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly socialAccounts: SocialAccountsService,
    @Inject(ANALYTICS_YOUTUBE_CLIENT) private readonly youtube: YouTubeAnalyticsClient,
    @Inject(PUBLISHED_POST_SOURCE) private readonly publishedPosts: PublishedPostSource,
  ) {}

  public async listCatalog(): Promise<AnalyticsMetricDefinition[]> {
    const records = await this.db.analyticsMetricDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ platform: "asc" }, { key: "asc" }],
    });
    return records.map((record) =>
      AnalyticsMetricDefinitionSchema.parse({
        platform: record.platform,
        key: record.key,
        label: record.label,
        description: record.description,
        accountEligibility: record.accountEligibility,
        requiredScopes: record.requiredScopes,
        granularities: record.granularities,
        sourceApi: record.sourceApi,
        documentationUrl: record.documentationUrl,
        availabilityNotes: record.availabilityNotes,
        verifiedAt: dateOnly(record.verifiedAt),
      }),
    );
  }

  public async scheduleCollection(
    context: WorkspaceContext,
    input: {
      channelId: string;
      socialAccountId: string;
      startDate: string;
      endDate: string;
    },
  ): Promise<{
    id: string;
    channelId: string;
    socialAccountId: string;
    startDate: string;
    endDate: string;
    status: "QUEUED";
    createdAt: string;
  }> {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Editor permission required to collect metrics");

    const channel = await this.db.channel.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.channelId } },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const authenticatedClient = await this.socialAccounts.authenticatedClient(
      context,
      input.socialAccountId,
    );
    if (
      authenticatedClient.account.channelId !== input.channelId ||
      authenticatedClient.account.platform !== "YOUTUBE"
    )
      throw new NotFoundException("YouTube account not found for channel");

    const hasAnalyticsScope = authenticatedClient.account.permissions.some(
      (permission) =>
        permission.permission === YOUTUBE_ANALYTICS_READ_SCOPE && permission.status === "GRANTED",
    );
    if (!hasAnalyticsScope)
      throw new ForbiddenException("The YouTube account does not grant YouTube Analytics access");

    if (!this.youtube.isConfigured())
      throw new ServiceUnavailableException("YouTube Analytics connector is not configured");
    if (!this.publishedPosts.isConfigured())
      throw new ServiceUnavailableException("Published-post source is not configured");

    const job = await this.db.metricCollectionJob.create({
      data: {
        workspaceId: context.workspaceId,
        channelId: input.channelId,
        socialAccountId: input.socialAccountId,
        requestedByUserId: context.userId,
        startDate: new Date(`${input.startDate}T00:00:00.000Z`),
        endDate: new Date(`${input.endDate}T00:00:00.000Z`),
      },
      select: {
        id: true,
        channelId: true,
        socialAccountId: true,
        startDate: true,
        endDate: true,
        status: true,
        createdAt: true,
      },
    });
    return {
      id: job.id,
      channelId: job.channelId,
      socialAccountId: job.socialAccountId,
      startDate: dateOnly(job.startDate),
      endDate: dateOnly(job.endDate),
      status: "QUEUED",
      createdAt: job.createdAt.toISOString(),
    };
  }

  public async collect(context: WorkspaceContext, jobId: string): Promise<MetricCollectionResult> {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Editor permission required to collect metrics");

    const job = await this.db.metricCollectionJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
      select: {
        id: true,
        channelId: true,
        socialAccountId: true,
        startDate: true,
        endDate: true,
        status: true,
        retryCount: true,
        nextAttemptAt: true,
      },
    });
    if (!job) throw new NotFoundException("Metric collection job not found");
    const now = new Date();
    if (job.status === "RUNNING")
      throw new ConflictException("Metric collection job is already running");
    if (job.status === "RETRY_WAIT" && job.nextAttemptAt > now)
      throw new ConflictException("Metric collection job is waiting for its retry window");

    const authenticatedClient = await this.socialAccounts.authenticatedClient(
      context,
      job.socialAccountId,
    );
    if (
      authenticatedClient.account.channelId !== job.channelId ||
      authenticatedClient.account.platform !== "YOUTUBE"
    )
      throw new NotFoundException("YouTube account not found for channel");
    const hasReadScope = authenticatedClient.account.permissions.some(
      (permission) =>
        permission.permission === YOUTUBE_ANALYTICS_READ_SCOPE && permission.status === "GRANTED",
    );
    if (!hasReadScope)
      throw new ForbiddenException("The YouTube account does not grant YouTube Analytics access");
    if (!this.youtube.isConfigured())
      throw new ServiceUnavailableException("YouTube Analytics connector is not configured");
    if (!this.publishedPosts.isConfigured())
      throw new ServiceUnavailableException("Published-post source is not configured");

    const startDate = dateOnly(job.startDate);
    const endDate = dateOnly(job.endDate);
    const run = await this.db.$transaction(async (transaction) => {
      const claimed = await transaction.metricCollectionJob.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id: job.id,
          status: job.status,
          ...(job.status === "RETRY_WAIT" ? { nextAttemptAt: { lte: now } } : {}),
        },
        data: { status: "RUNNING", lastErrorCode: null },
      });
      if (claimed.count === 0) return null;
      const previousRun = await transaction.metricCollectionRun.findFirst({
        where: { workspaceId: context.workspaceId, jobId: job.id },
        orderBy: { attempt: "desc" },
        select: { attempt: true },
      });
      return transaction.metricCollectionRun.create({
        data: {
          workspaceId: context.workspaceId,
          jobId: job.id,
          attempt: (previousRun?.attempt ?? 0) + 1,
          status: "RUNNING",
          sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
          startDate: job.startDate,
          endDate: job.endDate,
          startedAt: now,
        },
        select: { id: true },
      });
    });
    if (run === null) throw new ConflictException("Metric collection job is already running");

    try {
      const collectedAt = new Date();
      const channelMetrics = youtubeMetricKeysFor("CHANNEL");
      const videoMetrics = youtubeMetricKeysFor("VIDEO");
      const channelReport = await this.youtube.query({
        account: authenticatedClient,
        startDate,
        endDate,
        metrics: channelMetrics,
        granularity: "CHANNEL",
        videoIds: [],
      });
      const values: NormalizedMetricValue[] = this.normalizeReport(
        channelReport,
        "CHANNEL",
        startDate,
        endDate,
        channelMetrics,
        collectedAt,
        [{ remoteEntityId: null, startDate }],
      );

      const publishedPosts = await this.publishedPostsFor(
        context,
        job.channelId,
        job.socialAccountId,
        endDate,
      );
      const videoStarts = new Map<string, string>();
      for (const post of publishedPosts) {
        const publishedDay = dateOnly(new Date(post.publishedAt));
        const firstDay = publishedDay > startDate ? publishedDay : startDate;
        if (firstDay > endDate) continue;
        const existing = videoStarts.get(post.platformPostId);
        if (existing === undefined || firstDay < existing)
          videoStarts.set(post.platformPostId, firstDay);
      }
      const videoIds = [...videoStarts.keys()];
      for (let offset = 0; offset < videoIds.length; offset += videoFilterBatchSize) {
        const batch = videoIds.slice(offset, offset + videoFilterBatchSize);
        const report = await this.youtube.query({
          account: authenticatedClient,
          startDate,
          endDate,
          metrics: videoMetrics,
          granularity: "VIDEO",
          videoIds: batch,
        });
        values.push(
          ...this.normalizeReport(
            report,
            "VIDEO",
            startDate,
            endDate,
            videoMetrics,
            collectedAt,
            batch.map((remoteEntityId) => ({
              remoteEntityId,
              startDate: videoStarts.get(remoteEntityId) ?? startDate,
            })),
          ),
        );
      }

      const completeness = this.collectionCompleteness(values);
      const snapshotCount = await this.appendSnapshots(
        context,
        job.channelId,
        job.socialAccountId,
        run.id,
        values,
      );
      const finishedAt = new Date();
      await this.db.metricCollectionRun.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: run.id } },
        data: {
          status: "SUCCEEDED",
          completeness,
          snapshotCount,
          finishedAt,
        },
      });
      await this.db.metricCollectionJob.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: job.id } },
        data: {
          status: "SUCCEEDED",
          retryCount: 0,
          nextAttemptAt: finishedAt,
          lastErrorCode: null,
        },
      });
      return {
        jobId: job.id,
        runId: run.id,
        status: "SUCCEEDED",
        snapshotCount,
        completeness,
        retryCount: 0,
        nextAttemptAt: finishedAt.toISOString(),
        lastErrorCode: null,
      };
    } catch (error) {
      const failure = collectionFailure(error);
      const decision = failure.retryable
        ? retryDecision(
            job.retryCount,
            new Date(),
            failure.retryAfterSeconds,
            maximumCollectionRetries,
          )
        : { retry: false, nextAttemptAt: null };
      const retryCount = decision.retry ? job.retryCount + 1 : job.retryCount;
      const finishedAt = new Date();
      await this.db.metricCollectionRun.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: run.id } },
        data: { status: "FAILED", errorCode: failure.code, finishedAt },
      });
      await this.db.metricCollectionJob.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: job.id } },
        data: {
          status: decision.retry ? "RETRY_WAIT" : "FAILED_FINAL",
          retryCount,
          nextAttemptAt: decision.nextAttemptAt ?? finishedAt,
          lastErrorCode: failure.code,
        },
      });
      return {
        jobId: job.id,
        runId: run.id,
        status: decision.retry ? "RETRY_WAIT" : "FAILED_FINAL",
        snapshotCount: 0,
        completeness: null,
        retryCount,
        nextAttemptAt: (decision.nextAttemptAt ?? finishedAt).toISOString(),
        lastErrorCode: failure.code,
      };
    }
  }

  public async aggregate(
    context: WorkspaceContext,
    channelId: string,
    query: MetricAggregateQuery,
  ): Promise<MetricAggregate[]> {
    const channel = await this.db.channel.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: channelId } },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    const account = await this.db.socialAccount.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: context.workspaceId,
          id: query.socialAccountId,
        },
      },
      select: { id: true, channelId: true, platform: true },
    });
    if (!account || account.channelId !== channelId || account.platform !== "YOUTUBE")
      throw new NotFoundException("YouTube account not found for channel");

    const snapshots = await this.db.analyticsMetricSnapshot.findMany({
      where: {
        workspaceId: context.workspaceId,
        channelId,
        socialAccountId: account.id,
        entityGranularity: query.granularity,
        remoteEntityId: query.remoteEntityId ?? null,
        periodStart: { gte: new Date(`${query.startDate}T00:00:00.000Z`) },
        periodEnd: { lte: new Date(`${query.endDate}T00:00:00.000Z`) },
      },
      include: { definition: { select: { key: true } } },
      orderBy: [{ collectedAt: "desc" }, { id: "desc" }],
    });

    const latestByMetricDay = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      const key = `${snapshot.definition.key}:${dateOnly(snapshot.periodStart)}`;
      if (!latestByMetricDay.has(key)) latestByMetricDay.set(key, snapshot);
    }

    const expectedDays = calendarDays(query.startDate, query.endDate);
    const metrics = youtubeMetricCatalog.filter((metric) =>
      metric.granularities.some((granularity) => granularity === query.granularity),
    );

    return metrics.map((metric) => {
      const rows = [...latestByMetricDay.entries()]
        .filter(([key]) => key.startsWith(`${metric.key}:`))
        .map(([, row]) => row);
      const availableRows = rows.filter(
        (row) => row.availability === "AVAILABLE" && row.value !== null,
      );
      const unavailableDays = Math.max(0, expectedDays - availableRows.length);
      const aggregateCompleteness: MetricCompleteness =
        availableRows.length === 0
          ? "UNAVAILABLE"
          : unavailableDays > 0 ||
              rows.some(
                (row) => row.completeness !== "COMPLETE" || row.availability !== "AVAILABLE",
              )
            ? "PARTIAL"
            : "COMPLETE";
      const value =
        availableRows.length === 0
          ? null
          : availableRows.reduce((total, row) => total + Number(row.value), 0);
      const result = MetricAggregateSchema.parse({
        key: metric.key,
        value,
        unit: youtubeMetricUnit(metric.key),
        periodStart: query.startDate,
        periodEnd: query.endDate,
        collectedAt:
          rows.length === 0
            ? null
            : rows
                .reduce(
                  (latest, row) => (row.collectedAt > latest ? row.collectedAt : latest),
                  rows[0]!.collectedAt,
                )
                .toISOString(),
        sourceApis: [...new Set(rows.map((row) => row.sourceApi))],
        completeness: aggregateCompleteness,
        unavailableDays,
      });
      return result;
    });
  }

  private async publishedPostsFor(
    context: WorkspaceContext,
    channelId: string,
    socialAccountId: string,
    endDate: string,
  ): Promise<PublishedPostRecord[]> {
    const records: PublishedPostRecord[] = [];
    let after: string | null = null;
    let afterId: string | null = null;
    for (let page = 0; page < maximumPublishedPostPages; page += 1) {
      const batch = await this.publishedPosts.listPublishedRecords(
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
    const end = new Date(`${endDate}T23:59:59.999Z`);
    return records.filter(
      (record) =>
        record.workspaceId === context.workspaceId &&
        record.channelId === channelId &&
        record.accountId === socialAccountId &&
        record.platform === "YOUTUBE" &&
        new Date(record.publishedAt) <= end,
    );
  }

  private normalizeReport(
    report: YouTubeAnalyticsReport,
    granularity: "CHANNEL" | "VIDEO",
    startDate: string,
    endDate: string,
    metrics: readonly AnalyticsMetricKey[],
    collectedAt: Date,
    entities: readonly CollectionEntity[],
  ): NormalizedMetricValue[] {
    const headerIndex = new Map<string, number>();
    report.columnHeaders.forEach((header, index) => {
      if (!headerIndex.has(header.name)) headerIndex.set(header.name, index);
    });
    const dayIndex = headerIndex.get("day");
    const entityIndex = granularity === "VIDEO" ? headerIndex.get("video") : undefined;
    const rows = new Map<string, readonly (string | number | null)[]>();
    const reportRows = report.rows ?? [];
    for (const row of reportRows) {
      if (dayIndex === undefined) break;
      const day = row[dayIndex];
      if (typeof day !== "string") continue;
      const entity = entityIndex === undefined ? null : row[entityIndex];
      if (entityIndex !== undefined && typeof entity !== "string") continue;
      rows.set(`${entity ?? ""}:${day}`, row);
    }

    const values: NormalizedMetricValue[] = [];
    for (const entity of entities) {
      for (const day of calendarDates(entity.startDate, endDate)) {
        const row = rows.get(`${entity.remoteEntityId ?? ""}:${day}`);
        for (const metric of metrics) {
          const metricIndex = headerIndex.get(metric);
          const raw = row !== undefined && metricIndex !== undefined ? row[metricIndex] : undefined;
          const value = numericMetricValue(raw);
          const availability = value === null ? "UNAVAILABLE" : "AVAILABLE";
          const unavailableReason =
            value !== null
              ? null
              : row === undefined
                ? "NO_REPORT_ROW"
                : metricIndex === undefined
                  ? "MISSING_METRIC_COLUMN"
                  : "NO_METRIC_VALUE";
          values.push(
            NormalizedMetricValueSchema.parse({
              key: metric,
              value,
              unit: youtubeMetricUnit(metric),
              entityGranularity: granularity,
              remoteEntityId: entity.remoteEntityId,
              periodStart: day,
              periodEnd: day,
              collectedAt: collectedAt.toISOString(),
              sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
              completeness: availability === "AVAILABLE" ? "COMPLETE" : "UNAVAILABLE",
              availability,
              unavailableReason,
            }),
          );
        }
      }
    }
    return values;
  }

  private collectionCompleteness(values: readonly NormalizedMetricValue[]): MetricCompleteness {
    if (values.length === 0) return "UNAVAILABLE";
    const available = values.filter((value) => value.availability === "AVAILABLE").length;
    return available === values.length ? "COMPLETE" : available === 0 ? "UNAVAILABLE" : "PARTIAL";
  }

  public async appendSnapshots(
    context: WorkspaceContext,
    channelId: string,
    socialAccountId: string,
    runId: string,
    values: readonly unknown[],
  ): Promise<number> {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Editor permission required to store metrics");
    const normalizedValues = values.map((value) => NormalizedMetricValueSchema.parse(value));
    if (normalizedValues.length === 0) return 0;

    const duplicateKeys = new Set<string>();
    for (const value of normalizedValues) {
      const key = [
        value.key,
        value.entityGranularity,
        value.remoteEntityId ?? "",
        value.periodStart,
      ].join(":");
      if (duplicateKeys.has(key))
        throw new BadRequestException("A collection run cannot contain duplicate metric days");
      duplicateKeys.add(key);
    }

    return this.db.$transaction(async (transaction) => {
      const run = await transaction.metricCollectionRun.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: runId } },
        include: {
          job: {
            select: {
              channelId: true,
              socialAccountId: true,
              startDate: true,
              endDate: true,
            },
          },
        },
      });
      if (!run || run.job.channelId !== channelId || run.job.socialAccountId !== socialAccountId)
        throw new NotFoundException("Metric collection run not found");

      const account = await transaction.socialAccount.findUnique({
        where: {
          workspaceId_id: { workspaceId: context.workspaceId, id: socialAccountId },
        },
        select: { channelId: true, platform: true },
      });
      if (!account || account.channelId !== channelId || account.platform !== "YOUTUBE")
        throw new NotFoundException("YouTube account not found for channel");

      const definitions = await transaction.analyticsMetricDefinition.findMany({
        where: {
          platform: "YOUTUBE",
          key: { in: [...new Set(normalizedValues.map((value) => value.key))] },
          isActive: true,
        },
      });
      const definitionsByKey = new Map(
        definitions.map((definition) => [definition.key, definition]),
      );
      let appended = 0;

      for (const value of normalizedValues) {
        const definition = definitionsByKey.get(value.key);
        if (
          !definition ||
          definition.sourceApi !== value.sourceApi ||
          !definition.granularities.some((granularity) => granularity === value.entityGranularity)
        )
          throw new BadRequestException("Metric does not match the active YouTube catalog");

        const periodStart = new Date(`${value.periodStart}T00:00:00.000Z`);
        if (periodStart < run.job.startDate || periodStart > run.job.endDate)
          throw new BadRequestException("Metric day falls outside its collection job window");

        const identity = {
          workspaceId: context.workspaceId,
          channelId,
          socialAccountId,
          metricDefinitionId: definition.id,
          entityGranularity: value.entityGranularity,
          remoteEntityId: value.remoteEntityId,
          periodStart,
          periodEnd: periodStart,
        };
        if (value.availability === "UNAVAILABLE") {
          const priorAvailable = await transaction.analyticsMetricSnapshot.findFirst({
            where: { ...identity, availability: "AVAILABLE" },
            select: { id: true },
            orderBy: [{ collectedAt: "desc" }, { id: "desc" }],
          });
          if (priorAvailable) continue;
        }

        const previous = await transaction.analyticsMetricSnapshot.findFirst({
          where: identity,
          select: { id: true },
          orderBy: [{ collectedAt: "desc" }, { id: "desc" }],
        });
        await transaction.analyticsMetricSnapshot.create({
          data: {
            ...identity,
            runId,
            collectedAt: new Date(value.collectedAt),
            sourceApi: value.sourceApi,
            completeness: value.completeness,
            availability: value.availability,
            unavailableReason: value.unavailableReason,
            value: value.value,
            supersedesSnapshotId: previous?.id ?? null,
          },
        });
        appended += 1;
      }

      return appended;
    });
  }
}
