import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AnalyticsMetricDefinitionSchema,
  MetricAggregateSchema,
  NormalizedMetricValueSchema,
  type AnalyticsMetricDefinition,
  type MetricAggregate,
  type MetricCompleteness,
} from "@reelforge/contracts";
import type { Database } from "../identity/identity.types.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import {
  YOUTUBE_ANALYTICS_READ_SCOPE,
  youtubeMetricCatalog,
  youtubeMetricUnit,
} from "./analytics.catalog.js";
import {
  ANALYTICS_YOUTUBE_CLIENT,
  PUBLISHED_POST_SOURCE,
  type PublishedPostSource,
  type YouTubeAnalyticsClient,
} from "./analytics.tokens.js";
import type { MetricAggregateQuery } from "./analytics.validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const dayMilliseconds = 24 * 60 * 60 * 1000;

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
