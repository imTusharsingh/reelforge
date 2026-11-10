import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { redactString } from "@reelforge/observability";
import { z } from "zod";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import type { WorkflowQueueHealth } from "../orchestration/orchestration.types.js";
import { toAuditView } from "./audit.service.js";
import type { AuditEventView } from "./audit.types.js";

const limitSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

function safeMessage(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : redactString(value).slice(0, 500);
}

export type FailedItem = Readonly<{
  kind: string;
  id: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  refs: Readonly<Record<string, string | null>>;
  at: string;
}>;

export type FailedJobsView = Readonly<{
  generatedAt: string;
  counts: Readonly<Record<string, number>>;
  items: Readonly<Record<string, FailedItem[]>>;
}>;

export type QueueView = Readonly<{
  generatedAt: string;
  adapter: WorkflowQueueHealth;
  scope: "WORKSPACE";
  depth: Readonly<Record<string, Readonly<Record<string, number>>>>;
}>;

export type ProviderStatusView = Readonly<{
  generatedAt: string;
  windowHours: number;
  liveChecks: false;
  aiProviders: Array<
    Readonly<{
      providerId: string;
      capabilityId: string;
      succeeded: number;
      failed: number;
      lastRequestAt: string | null;
      lastErrorCode: string | null;
    }>
  >;
  socialAccounts: Array<
    Readonly<{
      id: string;
      channelId: string;
      platform: string;
      status: string;
      health: string;
      lastHealthCheckAt: string | null;
    }>
  >;
}>;

export type RecentEventsView = Readonly<{
  generatedAt: string;
  workflowEvents: Array<
    Readonly<{
      id: string;
      runId: string;
      eventType: string;
      correlationId: string;
      occurredAt: string;
    }>
  >;
  auditEvents: AuditEventView[];
}>;

const STATUS_COUNT_KEYS = {
  workflowSteps: ["QUEUED", "RUNNING", "RETRY_WAIT", "WAITING_EXTERNAL", "WAITING_APPROVAL"],
  workflowJobs: ["QUEUED", "RUNNING", "RETRY_WAIT"],
  renderJobs: ["QUEUED", "RUNNING"],
  metricCollectionJobs: ["QUEUED", "RUNNING", "RETRY_WAIT"],
  notificationDeliveries: ["PENDING", "SENDING", "RETRY_WAIT"],
  publishingDestinations: ["SCHEDULED", "PREFLIGHT", "UPLOADING", "REMOTE_PROCESSING"],
} as const;

function countMap(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
  keys: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) if (row.status in out) out[row.status] = row._count._all;
  return out;
}

/**
 * M19-T05 admin views. Workspace OWNER only, API only (no web UI). Every read is scoped to the
 * caller's workspace; there is no cross-tenant or platform-wide view. These are read-only Prisma
 * reads of other modules' tables (M16/M10/M09/M13/M14/M17/M08/M12), the same pattern Core approved
 * for M17's direct `outbox_events` read; no provider or platform is called.
 */
@Injectable()
export class AdminService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly orchestration: OrchestrationService,
  ) {}

  public async failedJobs(context: WorkspaceContext, query: unknown): Promise<FailedJobsView> {
    this.requireOwner(context);
    const { limit } = limitSchema.parse(query ?? {});
    const workspaceId = context.workspaceId;
    const runWhere = { workspaceId, state: "FAILED" as const };
    const stepWhere = { workspaceId, status: "RECONCILIATION_REQUIRED" as const };
    const jobWhere = {
      workspaceId,
      status: { in: ["FAILED", "DEAD_LETTER"] as Array<"FAILED" | "DEAD_LETTER"> },
    };
    const renderWhere = {
      workspaceId,
      status: {
        in: ["FAILED_RETRYABLE", "FAILED_FINAL"] as Array<"FAILED_RETRYABLE" | "FAILED_FINAL">,
      },
    };
    const sceneWhere = {
      workspaceId,
      status: { in: ["FAILED", "PARTIAL"] as Array<"FAILED" | "PARTIAL"> },
    };
    const publishWhere = {
      workspaceId,
      status: {
        in: ["FAILED_RETRYABLE", "FAILED_FINAL", "RECONCILIATION_REQUIRED"] as Array<
          "FAILED_RETRYABLE" | "FAILED_FINAL" | "RECONCILIATION_REQUIRED"
        >,
      },
    };
    const metricWhere = { workspaceId, status: "FAILED_FINAL" as const };
    const deliveryWhere = { workspaceId, status: "FAILED" as const };
    const [
      runs,
      runCount,
      steps,
      stepCount,
      jobs,
      jobCount,
      renders,
      renderCount,
      scenes,
      sceneCount,
      destinations,
      destinationCount,
      metricJobs,
      metricCount,
      deliveries,
      deliveryCount,
    ] = await Promise.all([
      this.db.workflowRun.findMany({
        where: runWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.workflowRun.count({ where: runWhere }),
      this.db.workflowStep.findMany({
        where: stepWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.workflowStep.count({ where: stepWhere }),
      this.db.workflowJob.findMany({
        where: jobWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.workflowJob.count({ where: jobWhere }),
      this.db.renderJob.findMany({
        where: renderWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.renderJob.count({ where: renderWhere }),
      this.db.sceneMediaJob.findMany({
        where: sceneWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.sceneMediaJob.count({ where: sceneWhere }),
      this.db.publishingDestination.findMany({
        where: publishWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.publishingDestination.count({ where: publishWhere }),
      this.db.metricCollectionJob.findMany({
        where: metricWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.metricCollectionJob.count({ where: metricWhere }),
      this.db.notificationDelivery.findMany({
        where: deliveryWhere,
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      this.db.notificationDelivery.count({ where: deliveryWhere }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        workflowRuns: runCount,
        workflowStepsReconciliationRequired: stepCount,
        workflowJobs: jobCount,
        renderJobs: renderCount,
        sceneMediaJobs: sceneCount,
        publishingDestinations: destinationCount,
        metricCollectionJobs: metricCount,
        notificationDeliveries: deliveryCount,
      },
      items: {
        workflowRuns: runs.map((row) => ({
          kind: "WORKFLOW_RUN",
          id: row.id,
          status: row.state,
          errorCode: row.lastErrorCode,
          errorMessage: safeMessage(row.lastErrorMessage),
          refs: {
            channelId: row.channelId,
            correlationId: row.correlationId,
            stepKey: row.currentStepKey,
          },
          at: row.updatedAt.toISOString(),
        })),
        workflowStepsReconciliationRequired: steps.map((row) => ({
          kind: "WORKFLOW_STEP",
          id: row.id,
          status: row.status,
          errorCode: row.errorCode,
          errorMessage: safeMessage(row.errorMessage),
          refs: { runId: row.runId, stepKey: row.stepKey },
          at: row.updatedAt.toISOString(),
        })),
        workflowJobs: jobs.map((row) => ({
          kind: "WORKFLOW_JOB",
          id: row.id,
          status: row.status,
          errorCode: row.errorCode,
          errorMessage: safeMessage(row.errorMessage),
          refs: { runId: row.runId, stepId: row.stepId, jobId: row.jobId },
          at: row.updatedAt.toISOString(),
        })),
        renderJobs: renders.map((row) => ({
          kind: "RENDER_JOB",
          id: row.id,
          status: row.status,
          errorCode: row.errorCode,
          errorMessage: safeMessage(row.errorMessage),
          refs: { sceneMediaJobId: row.sceneMediaJobId },
          at: row.updatedAt.toISOString(),
        })),
        sceneMediaJobs: scenes.map((row) => ({
          kind: "SCENE_MEDIA_JOB",
          id: row.id,
          status: row.status,
          errorCode: null,
          errorMessage: null,
          refs: { scriptId: row.scriptId, channelId: row.channelId },
          at: row.updatedAt.toISOString(),
        })),
        publishingDestinations: destinations.map((row) => ({
          kind: "PUBLISHING_DESTINATION",
          id: row.id,
          status: row.status,
          errorCode: row.lastErrorCode,
          errorMessage: safeMessage(row.lastErrorMessage),
          refs: { scheduledPostId: row.scheduledPostId, socialAccountId: row.socialAccountId },
          at: row.updatedAt.toISOString(),
        })),
        metricCollectionJobs: metricJobs.map((row) => ({
          kind: "METRIC_COLLECTION_JOB",
          id: row.id,
          status: row.status,
          errorCode: row.lastErrorCode,
          errorMessage: null,
          refs: { channelId: row.channelId, socialAccountId: row.socialAccountId },
          at: row.updatedAt.toISOString(),
        })),
        notificationDeliveries: deliveries.map((row) => ({
          kind: "NOTIFICATION_DELIVERY",
          id: row.id,
          status: row.status,
          errorCode: row.lastErrorCode,
          errorMessage: safeMessage(row.lastErrorMessage),
          refs: { eventId: row.eventId, channel: row.channel },
          at: row.updatedAt.toISOString(),
        })),
      },
    };
  }

  /**
   * Queue depth from Postgres (the source of truth, ADR-006), scoped to this workspace. Redis/BullMQ
   * counts are shared across tenants, so only the adapter state is reported, not raw Redis counts.
   */
  public async queue(context: WorkspaceContext): Promise<QueueView> {
    this.requireOwner(context);
    const workspaceId = context.workspaceId;
    const [adapter, steps, jobs, renders, metricJobs, deliveries, destinations] = await Promise.all(
      [
        this.orchestration.queueHealth(),
        this.db.workflowStep.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.db.workflowJob.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.db.renderJob.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.db.metricCollectionJob.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.db.notificationDelivery.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
        this.db.publishingDestination.groupBy({
          by: ["status"],
          where: { workspaceId },
          _count: { _all: true },
        }),
      ],
    );
    return {
      generatedAt: new Date().toISOString(),
      adapter,
      scope: "WORKSPACE",
      depth: {
        workflowSteps: countMap(steps, STATUS_COUNT_KEYS.workflowSteps),
        workflowJobs: countMap(jobs, STATUS_COUNT_KEYS.workflowJobs),
        renderJobs: countMap(renders, STATUS_COUNT_KEYS.renderJobs),
        metricCollectionJobs: countMap(metricJobs, STATUS_COUNT_KEYS.metricCollectionJobs),
        notificationDeliveries: countMap(deliveries, STATUS_COUNT_KEYS.notificationDeliveries),
        publishingDestinations: countMap(destinations, STATUS_COUNT_KEYS.publishingDestinations),
      },
    };
  }

  /** Provider status from persisted data only (M08 ledger, M12 account health). No live checks. */
  public async providers(context: WorkspaceContext): Promise<ProviderStatusView> {
    this.requireOwner(context);
    const windowHours = 24;
    const since = new Date(Date.now() - windowHours * 3_600_000);
    const workspaceId = context.workspaceId;
    const [grouped, lastErrors, accounts] = await Promise.all([
      this.db.providerRequest.groupBy({
        by: ["providerId", "capabilityId", "status"],
        where: { workspaceId, createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.db.providerRequest.findMany({
        where: { workspaceId, createdAt: { gte: since }, status: "FAILED" },
        orderBy: { createdAt: "desc" },
        distinct: ["providerId", "capabilityId"],
        select: { providerId: true, capabilityId: true, errorCode: true },
      }),
      this.db.socialAccount.findMany({
        where: { workspaceId },
        orderBy: [{ channelId: "asc" }, { platform: "asc" }],
        take: 200,
        select: {
          id: true,
          channelId: true,
          platform: true,
          status: true,
          health: true,
          lastHealthCheckAt: true,
        },
      }),
    ]);
    const providers = new Map<
      string,
      {
        providerId: string;
        capabilityId: string;
        succeeded: number;
        failed: number;
        last: Date | null;
      }
    >();
    for (const row of grouped) {
      const key = `${row.providerId}\u0000${row.capabilityId}`;
      const entry = providers.get(key) ?? {
        providerId: row.providerId,
        capabilityId: row.capabilityId,
        succeeded: 0,
        failed: 0,
        last: null,
      };
      if (row.status === "SUCCEEDED") entry.succeeded += row._count._all;
      else entry.failed += row._count._all;
      const max = row._max.createdAt;
      if (max && (entry.last === null || max > entry.last)) entry.last = max;
      providers.set(key, entry);
    }
    const errorByKey = new Map(
      lastErrors.map((row) => [`${row.providerId}\u0000${row.capabilityId}`, row.errorCode]),
    );
    return {
      generatedAt: new Date().toISOString(),
      windowHours,
      liveChecks: false,
      aiProviders: [...providers.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({
          providerId: entry.providerId,
          capabilityId: entry.capabilityId,
          succeeded: entry.succeeded,
          failed: entry.failed,
          lastRequestAt: entry.last?.toISOString() ?? null,
          lastErrorCode: errorByKey.get(key) ?? null,
        })),
      socialAccounts: accounts.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        platform: row.platform,
        status: row.status,
        health: row.health,
        lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
      })),
    };
  }

  public async recentEvents(context: WorkspaceContext, query: unknown): Promise<RecentEventsView> {
    this.requireOwner(context);
    const { limit } = limitSchema.parse(query ?? {});
    const workspaceId = context.workspaceId;
    const [events, audits] = await Promise.all([
      this.db.workflowEvent.findMany({
        where: { workspaceId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        select: { id: true, runId: true, eventType: true, correlationId: true, occurredAt: true },
      }),
      this.db.auditEvent.findMany({
        where: { workspaceId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      workflowEvents: events.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
      auditEvents: audits.map(toAuditView),
    };
  }

  private requireOwner(context: WorkspaceContext): void {
    if (context.role !== "OWNER") throw new ForbiddenException("Owner permission required");
  }
}
