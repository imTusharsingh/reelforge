import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "../identity/identity.types.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import { PerformanceIntelligenceService } from "../performance-intelligence/performance-intelligence.service.js";
import { PublishingService } from "../publishing/publishing.service.js";
import { QualityService } from "../quality/quality.service.js";
import type { NotificationEventType } from "./notifications.catalog.js";
import { buildNotificationLink } from "./notifications.links.js";

export type IntakeCursor = Readonly<{ at: Date; id: string }>;

export type NotificationEventInput = Readonly<{
  workspaceId: string;
  channelId: string | null;
  eventType: NotificationEventType;
  sourceModule: string;
  /** Unique per workspace; also the per-recipient notification dedupe key. */
  sourceKey: string;
  correlationId: string | null;
  subjectType: string;
  subjectId: string;
  link: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}>;

export type IntakeItem = Readonly<{
  cursor: IntakeCursor;
  /** null = the row was read but is not notifiable; the cursor still advances past it. */
  event: NotificationEventInput | null;
}>;

export type NotificationIntakeSource = Readonly<{
  key: string;
  read: (after: IntakeCursor | null, until: Date, limit: number) => Promise<IntakeItem[]>;
}>;

const runEventTypes: Readonly<Record<string, NotificationEventType>> = {
  WORKFLOW_STEP_FAILED: "RUN_FAILED",
  WORKFLOW_STEP_RECONCILIATION_REQUIRED: "RUN_RECONCILIATION_REQUIRED",
  WORKFLOW_APPROVAL_REQUESTED: "RUN_WAITING_APPROVAL",
  WORKFLOW_RUN_SUCCEEDED: "RUN_SUCCEEDED",
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      result[key] = value;
  }
  return result;
}

/**
 * Read-only adapters over other modules' persisted events. M13 events come from the shared
 * `outbox_events` table; everything else comes through `@internal` read methods on the owning
 * module's public service. Cursors are strict `(timestamp, id)` keyset positions: a read returns only
 * rows with `ts > at OR (ts = at AND id > id)`, ordered by `(ts, id)`, so any number of rows sharing
 * one timestamp is paged through without stalling. Redelivery (for example after a cursor reset) is
 * still a no-op because of the unique `(workspaceId, sourceKey)` on `notification_events`.
 * All source timestamps are written by Prisma with millisecond precision, which matches the JS `Date`
 * kept in the cursor.
 */
@Injectable()
export class NotificationIntakeSources {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly orchestration: OrchestrationService,
    private readonly quality: QualityService,
    private readonly publishing: PublishingService,
    private readonly performance: PerformanceIntelligenceService,
  ) {}

  public all(): NotificationIntakeSource[] {
    return [
      { key: "m13.outbox", read: (after, until, limit) => this.outbox(after, until, limit) },
      {
        key: "m13.reconciliation",
        read: (after, until, limit) => this.publishReconciliation(after, until, limit),
      },
      { key: "m16.run-events", read: (after, until, limit) => this.runEvents(after, until, limit) },
      {
        key: "m11.review-requests",
        read: (after, until, limit) => this.reviewRequests(after, until, limit),
      },
      {
        key: "m11.review-decisions",
        read: (after, until, limit) => this.reviewDecisions(after, until, limit),
      },
      {
        key: "m15.insight-reports",
        read: (after, until, limit) => this.insightReports(after, until, limit),
      },
    ];
  }

  private async outbox(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: {
        eventType: { in: ["PostPublished", "PublishFailed"] },
        occurredAt: { lte: until },
        ...(after === null
          ? {}
          : {
              OR: [
                { occurredAt: { gt: after.at } },
                { occurredAt: after.at, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    return rows.map((row) => {
      const payload = record(row.payload);
      const postId = typeof payload["postId"] === "string" ? payload["postId"] : null;
      const eventType: NotificationEventType =
        row.eventType === "PostPublished" ? "PUBLISH_SUCCEEDED" : "PUBLISH_FAILED";
      return {
        cursor: { at: row.occurredAt, id: row.id },
        event: {
          workspaceId: row.workspaceId,
          channelId: row.channelId,
          eventType,
          sourceModule: "M13",
          sourceKey: `m13:outbox:${row.id}`,
          correlationId: row.correlationId,
          subjectType: "scheduled_post",
          subjectId: postId ?? row.aggregateId,
          link:
            postId === null
              ? null
              : buildNotificationLink("publishedPost", {
                  workspaceId: row.workspaceId,
                  scheduledPostId: postId,
                }),
          payload: {
            ...pick(payload, ["postId", "platform", "platformPostId", "failureCode", "retryable"]),
            destinationId: row.aggregateId,
          },
          occurredAt: row.occurredAt,
        },
      };
    });
  }

  private async publishReconciliation(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.publishing.listReconciliationRequiredAfter({ after, until, limit });
    return rows.map((row) => ({
      cursor: { at: row.updatedAt, id: row.id },
      event: {
        workspaceId: row.workspaceId,
        channelId: row.channelId,
        eventType: "PUBLISH_RECONCILIATION_REQUIRED",
        sourceModule: "M13",
        // One notification per destination per publish-job retry generation.
        sourceKey: `m13:reconciliation:${row.id}:${row.retryCount}`,
        correlationId: null,
        subjectType: "scheduled_post",
        subjectId: row.scheduledPostId,
        link: buildNotificationLink("publishedPost", {
          workspaceId: row.workspaceId,
          scheduledPostId: row.scheduledPostId,
        }),
        payload: {
          destinationId: row.id,
          platform: row.platform,
          ...(row.lastErrorCode === null ? {} : { errorCode: row.lastErrorCode }),
        },
        occurredAt: row.updatedAt,
      },
    }));
  }

  private async runEvents(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.orchestration.listEventsAfter({
      eventTypes: Object.keys(runEventTypes),
      after,
      until,
      limit,
    });
    return rows.map((row) => {
      const eventType = runEventTypes[row.eventType];
      if (eventType === undefined)
        return { cursor: { at: row.occurredAt, id: row.id }, event: null };
      return {
        cursor: { at: row.occurredAt, id: row.id },
        event: {
          workspaceId: row.workspaceId,
          channelId: row.channelId,
          eventType,
          sourceModule: "M16",
          // A run succeeds once; failures and waits can recur after a retry, so key by event id.
          sourceKey:
            eventType === "RUN_SUCCEEDED"
              ? `m16:run-succeeded:${row.runId}`
              : `m16:event:${row.id}`,
          correlationId: row.correlationId,
          subjectType: "workflow_run",
          subjectId: row.runId,
          link: buildNotificationLink("workflowRun", {
            workspaceId: row.workspaceId,
            runId: row.runId,
          }),
          payload: { runId: row.runId, ...pick(row.payload, ["stepKey", "code", "deadLetter"]) },
          occurredAt: row.occurredAt,
        },
      };
    });
  }

  private async reviewRequests(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.quality.listReviewRequestsAfter({ after, until, limit });
    return rows.map((row) => ({
      cursor: { at: row.createdAt, id: row.id },
      event: {
        workspaceId: row.workspaceId,
        channelId: row.channelId,
        eventType: "REVIEW_NEEDED",
        sourceModule: "M11",
        sourceKey: `m11:review-needed:${row.id}`,
        correlationId: null,
        subjectType: "quality_review_run",
        subjectId: row.id,
        link: buildNotificationLink("reviewItem", {
          workspaceId: row.workspaceId,
          reviewRunId: row.id,
        }),
        payload: { reviewRunId: row.id, renderJobId: row.renderJobId, reviewStatus: row.status },
        occurredAt: row.createdAt,
      },
    }));
  }

  private async reviewDecisions(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.quality.listDecisionsAfter({ after, until, limit });
    return rows.map((row) => ({
      cursor: { at: row.createdAt, id: row.id },
      event: {
        workspaceId: row.workspaceId,
        channelId: row.channelId,
        eventType: row.action === "APPROVE" ? "REVIEW_APPROVED" : "REVIEW_REJECTED",
        sourceModule: "M11",
        sourceKey: `m11:decision:${row.id}`,
        correlationId: null,
        subjectType: "quality_review_run",
        subjectId: row.reviewRunId,
        link: buildNotificationLink("reviewItem", {
          workspaceId: row.workspaceId,
          reviewRunId: row.reviewRunId,
        }),
        payload: { reviewRunId: row.reviewRunId, decisionId: row.id, action: row.action },
        occurredAt: row.createdAt,
      },
    }));
  }

  private async insightReports(
    after: IntakeCursor | null,
    until: Date,
    limit: number,
  ): Promise<IntakeItem[]> {
    const rows = await this.performance.listInsightReportsAfter({ after, until, limit });
    return rows.map((row) => ({
      cursor: { at: row.createdAt, id: row.id },
      event: {
        workspaceId: row.workspaceId,
        channelId: row.channelId,
        eventType: "ANALYTICS_REPORT_READY",
        sourceModule: "M15",
        sourceKey: `m15:insight-report:${row.id}`,
        correlationId: null,
        subjectType: "performance_insight_report",
        subjectId: row.id,
        link: buildNotificationLink("analyticsDetail", {
          workspaceId: row.workspaceId,
          channelId: row.channelId,
          reportId: row.id,
        }),
        payload: { reportId: row.id, status: row.status },
        occurredAt: row.createdAt,
      },
    }));
  }
}
