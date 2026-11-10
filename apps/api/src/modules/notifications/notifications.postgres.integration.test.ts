import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService } from "../channel/channel.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import { PerformanceIntelligenceService } from "../performance-intelligence/performance-intelligence.service.js";
import { WorkspaceRepository } from "../workspace/workspace.repository.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  NotConfiguredNotificationEmail,
  type NotificationsConfig,
  NotificationEmailError,
  type NotificationEmailPort,
} from "./notifications.ports.js";
import { NotificationsService } from "./notifications.service.js";
import { NotificationIntakeSources } from "./notifications.sources.js";
import { ChannelReportsService } from "./reports.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const channelId = randomUUID();
const pausedChannelId = randomUUID();
const otherChannelId = randomUUID();

const owner: WorkspaceContext = { workspaceId, userId: ownerId, role: "OWNER" };
const editor: WorkspaceContext = { workspaceId, userId: editorId, role: "EDITOR" };
const viewer: WorkspaceContext = { workspaceId, userId: viewerId, role: "VIEWER" };
const outsider: WorkspaceContext = {
  workspaceId: otherWorkspaceId,
  userId: outsiderId,
  role: "OWNER",
};

class FakeEmail implements NotificationEmailPort {
  public readonly sent: string[] = [];
  public failures: Array<NotificationEmailError | Error> = [];
  public isConfigured(): boolean {
    return true;
  }
  public send(message: { to: string; idempotencyKey: string }): Promise<{
    providerMessageId: string;
  }> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.sent.push(message.idempotencyKey);
    return Promise.resolve({ providerMessageId: `fake-${message.idempotencyKey}` });
  }
}

suite("M17 notifications and reports (PostgreSQL)", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let clockNow = new Date();
  const clock = (): Date => clockNow;

  function workspaces(): WorkspaceService {
    return new WorkspaceService(db as never, new WorkspaceRepository(db as never));
  }

  function orchestration(): OrchestrationService {
    const none = undefined as never;
    return new OrchestrationService(db as never, none, none, none, none, none, none, clock);
  }

  function performance(): PerformanceIntelligenceService {
    const none = undefined as never;
    return new PerformanceIntelligenceService(db as never, none, none, none);
  }

  function sources(): NotificationIntakeSources {
    return new NotificationIntakeSources(
      db as never,
      orchestration(),
      { listReviewRequestsAfter: async () => [], listDecisionsAfter: async () => [] } as never,
      { listReconciliationRequiredAfter: async () => [] } as never,
      performance(),
    );
  }

  // The fixtures are back-dated, so these suites backfill from an empty cursor by default.
  const backfill: NotificationsConfig = { ...DEFAULT_NOTIFICATIONS_CONFIG, intakeBackfill: true };

  function notifications(
    email: NotificationEmailPort = new NotConfiguredNotificationEmail(),
    config: NotificationsConfig = backfill,
  ): NotificationsService {
    return new NotificationsService(db as never, workspaces(), sources(), email, clock, config);
  }

  function reports(service: NotificationsService = notifications()): ChannelReportsService {
    return new ChannelReportsService(
      db as never,
      new ChannelService(db as never),
      { listPublishedRecords: async () => [] } as never,
      { list: async () => [] } as never,
      { listLatestSnapshots: async () => [] } as never,
      performance(),
      orchestration(),
      service,
      clock,
      DEFAULT_NOTIFICATIONS_CONFIG,
    );
  }

  async function membershipId(userId: string, ws = workspaceId): Promise<string> {
    const row = await db!.workspaceMembership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: ws, userId } },
    });
    return row.id;
  }

  async function outbox(
    ws: string,
    channel: string,
    eventType: "PostPublished" | "PublishFailed",
    occurredAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    const postId = randomUUID();
    await db!.outboxEvent.create({
      data: {
        id,
        workspaceId: ws,
        channelId: channel,
        eventType,
        eventVersion: 1,
        correlationId: randomUUID(),
        aggregateType: "publishing_destination",
        aggregateId: randomUUID(),
        idempotencyKey: `m17-test:${id}`,
        payload:
          eventType === "PostPublished"
            ? { postId, platform: "YOUTUBE", platformPostId: "yt-1" }
            : { postId, failureCode: "YOUTUBE_PROCESSING_FAILED", retryable: false },
        occurredAt,
      },
    });
    return id;
  }

  beforeAll(async () => {
    if (!db) return;
    // The fixtures below use back-dated timestamps, so start from fresh M17-owned cursors.
    await db.notificationIntakeCursor.deleteMany({});
    await db.user.createMany({
      data: [ownerId, editorId, viewerId, outsiderId].map((id) => ({
        id,
        email: `${id}@m17.integration.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m17-integration" },
        { id: otherWorkspaceId, name: "m17-other" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: editorId, role: "EDITOR" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: otherWorkspaceId, userId: outsiderId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        { id: channelId, workspaceId, name: "M17 NY", timezone: "America/New_York" },
        {
          id: pausedChannelId,
          workspaceId,
          name: "M17 paused",
          timezone: "Asia/Kolkata",
          status: "PAUSED",
        },
        { id: otherChannelId, workspaceId: otherWorkspaceId, name: "M17 other", timezone: "UTC" },
      ],
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, editorId, viewerId, outsiderId] } } });
    await db.$disconnect();
  });

  it("worker intake records typed events once; redelivery and re-fan-out are no-ops", async () => {
    if (!db) return;
    clockNow = new Date();
    const earlier = new Date(clockNow.getTime() - 5 * 60_000);
    const published = await outbox(workspaceId, channelId, "PostPublished", earlier);
    const failed = await outbox(workspaceId, channelId, "PublishFailed", earlier);
    const foreign = await outbox(otherWorkspaceId, otherChannelId, "PublishFailed", earlier);
    const runId = randomUUID();
    await db.workflowRun.create({
      data: {
        id: runId,
        workspaceId,
        channelId,
        correlationId: randomUUID(),
        idempotencyKey: `m17-${runId}`,
        state: "FAILED",
      },
    });
    const runEventId = randomUUID();
    await db.workflowEvent.create({
      data: {
        id: runEventId,
        workspaceId,
        runId,
        eventType: "WORKFLOW_STEP_FAILED",
        correlationId: randomUUID(),
        payload: { stepKey: "RENDER", code: "RENDER_FAILED", deadLetter: true },
        occurredAt: earlier,
      },
    });
    // Too recent: inside the settle window, so it is not consumed yet.
    const settling = await outbox(workspaceId, channelId, "PostPublished", clockNow);

    const service = notifications();
    await service.runIntake(clockNow);
    const keys = async (): Promise<string[]> =>
      (
        await db.notificationEvent.findMany({
          where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
          orderBy: { sourceKey: "asc" },
        })
      ).map((event) => event.sourceKey);
    const first = await keys();
    expect(first).toEqual(
      [
        `m13:outbox:${published}`,
        `m13:outbox:${failed}`,
        `m13:outbox:${foreign}`,
        `m16:event:${runEventId}`,
      ].sort(),
    );
    expect(first).not.toContain(`m13:outbox:${settling}`);
    const runEvent = await db.notificationEvent.findFirstOrThrow({
      where: { workspaceId, sourceKey: `m16:event:${runEventId}` },
    });
    expect(runEvent.eventType).toBe("RUN_FAILED");
    expect(runEvent.link).toBe(`/workspaces/${workspaceId}/orchestration/runs/${runId}`);

    // Same tick again, then a full redelivery from scratch (cursors reset): nothing new.
    await service.runIntake(clockNow);
    await db.notificationIntakeCursor.deleteMany({});
    await service.runIntake(clockNow);
    expect(await keys()).toEqual(first);

    await service.fanOutPending(clockNow);
    const inApp = await db.notification.findMany({ where: { workspaceId } });
    // 3 in-workspace events x 3 members (all ALL_MEMBERS types).
    expect(inApp).toHaveLength(9);
    const foreignInApp = await db.notification.findMany({
      where: { workspaceId: otherWorkspaceId },
    });
    expect(foreignInApp).toHaveLength(1);
    expect(foreignInApp[0]?.recipientMemberId).toBe(
      await membershipId(outsiderId, otherWorkspaceId),
    );
    // PUBLISH_FAILED and RUN_FAILED default to email: 2 events x 3 members.
    expect(await db.notificationDelivery.count({ where: { workspaceId } })).toBe(6);

    // Force a re-fan-out of every event: unique dedupe keys keep it a no-op.
    await db.notificationEvent.updateMany({
      where: { workspaceId },
      data: { fanoutStatus: "PENDING", fannedOutAt: null },
    });
    await service.fanOutPending(clockNow);
    expect(await db.notification.count({ where: { workspaceId } })).toBe(9);
    expect(await db.notificationDelivery.count({ where: { workspaceId } })).toBe(6);
  });

  it("email NOT_CONFIGURED records SKIPPED_NOT_CONFIGURED and never SENT; in-app still works", async () => {
    if (!db) return;
    const result = await notifications().processDueDeliveries(clockNow);
    expect(result.sent).toBe(0);
    const rows = await db.notificationDelivery.findMany({ where: { workspaceId } });
    expect(rows.every((row) => row.status === "SKIPPED_NOT_CONFIGURED")).toBe(true);
    expect(rows.every((row) => row.lastErrorCode === "EMAIL_NOT_CONFIGURED")).toBe(true);
    const mine = await notifications().listMine(owner, {});
    expect(mine.items.length).toBe(3);
  });

  it("failed delivery is visible, retryable, backs off, and succeeds only on a real send", async () => {
    if (!db) return;
    const email = new FakeEmail();
    const service = notifications(email);
    const [delivery] = await service.listMyDeliveries(owner);
    expect(delivery?.status).toBe("SKIPPED_NOT_CONFIGURED");
    const retried = await service.retryDelivery(owner, delivery!.id);
    expect(retried.status).toBe("PENDING");
    await expect(service.retryDelivery(owner, delivery!.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Another member cannot see or retry my delivery.
    await expect(service.retryDelivery(editor, delivery!.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    email.failures.push(new NotificationEmailError("throttled", "RATE_LIMITED", true));
    await service.processDueDeliveries(clockNow);
    let row = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(row.status).toBe("RETRY_WAIT");
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe("RATE_LIMITED");
    expect(row.nextAttemptAt?.getTime()).toBe(clockNow.getTime() + 60_000);

    // Not due yet.
    await service.processDueDeliveries(new Date(clockNow.getTime() + 30_000));
    expect(email.sent).toHaveLength(0);

    await service.processDueDeliveries(new Date(clockNow.getTime() + 61_000));
    row = await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(2);
    expect(row.providerMessageId).toBe(`fake-${delivery!.id}`);
    expect(email.sent).toEqual([delivery!.id]);

    // A non-retryable error goes straight to FAILED and is visible to the member.
    const [, second] = await service.listMyDeliveries(owner);
    await service.retryDelivery(owner, second!.id);
    email.failures.push(new NotificationEmailError("bad address", "INVALID_RECIPIENT", false));
    await service.processDueDeliveries(new Date(clockNow.getTime() + 62_000));
    const failed = (await service.listMyDeliveries(owner)).find((item) => item.id === second!.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.lastErrorCode).toBe("INVALID_RECIPIENT");
  });

  it("respects per-member preferences with defaults when no row exists", async () => {
    if (!db) return;
    const service = notifications();
    const defaults = await service.getPreferences(viewer);
    expect(defaults.find((item) => item.eventType === "RUN_FAILED")).toMatchObject({
      inApp: true,
      email: true,
      isDefault: true,
    });
    await service.putPreferences(viewer, {
      preferences: [{ eventType: "PUBLISH_SUCCEEDED", inApp: false, email: false }],
    });
    await service.putPreferences(editor, {
      preferences: [{ eventType: "PUBLISH_FAILED", inApp: true, email: false }],
    });
    await expect(
      service.putPreferences(viewer, {
        preferences: [{ eventType: "NOT_A_TYPE", inApp: true, email: true }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    clockNow = new Date(clockNow.getTime() + 120_000);
    const before = new Date(clockNow.getTime() - 60_000);
    const published = await outbox(workspaceId, channelId, "PostPublished", before);
    const failed = await outbox(workspaceId, channelId, "PublishFailed", before);
    await service.runIntake(clockNow);
    await service.fanOutPending(clockNow);
    const viewerMember = await membershipId(viewerId);
    const editorMember = await membershipId(editorId);
    const forEvent = (key: string): Promise<Array<{ recipientMemberId: string }>> =>
      db.notification.findMany({ where: { workspaceId, dedupeKey: key } });
    const publishedRows = await forEvent(`m13:outbox:${published}`);
    expect(publishedRows.map((row) => row.recipientMemberId)).not.toContain(viewerMember);
    expect(publishedRows).toHaveLength(2);
    expect(await forEvent(`m13:outbox:${failed}`)).toHaveLength(3);
    const failedDeliveries = await db.notificationDelivery.findMany({
      where: { workspaceId, dedupeKey: `m13:outbox:${failed}` },
    });
    expect(failedDeliveries.map((row) => row.recipientMemberId)).not.toContain(editorMember);
    expect(failedDeliveries).toHaveLength(2);
  });

  it("read state is per member; other members and tenants are denied", async () => {
    if (!db) return;
    const service = notifications();
    const unread = await service.listMine(owner, { unread: "true" });
    expect(unread.unreadCount).toBeGreaterThan(1);
    const target = unread.items[0]!;
    const read = await service.markRead(owner, target.id);
    expect(read.readAt).not.toBeNull();
    const again = await service.markRead(owner, target.id);
    expect(again.readAt).toBe(read.readAt);
    expect((await service.listMine(owner, { unread: "true" })).unreadCount).toBe(
      unread.unreadCount - 1,
    );
    await expect(service.markRead(editor, target.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.markRead(outsider, target.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(workspaces().context(outsiderId, workspaceId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // A forged context for a workspace the user does not belong to resolves no member.
    await expect(
      service.listMine({ workspaceId, userId: outsiderId, role: "OWNER" }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const all = await service.markAllRead(owner);
    expect(all.updated).toBe(unread.unreadCount - 1);
    expect((await service.listMine(owner, {})).unreadCount).toBe(0);
    expect((await service.listMine(viewer, { unread: "true" })).unreadCount).toBeGreaterThan(0);
  });

  it("reports: idempotent per period, DST-aware, missing data marked, roles enforced", async () => {
    if (!db) return;
    clockNow = new Date("2026-11-10T12:00:00.000Z");
    const service = reports();
    const body = { channelId, periodType: "DAILY", periodStartDate: "2026-11-01" };
    await expect(service.generate(viewer, body)).rejects.toBeInstanceOf(ForbiddenException);
    const first = await service.generate(editor, body);
    // 2026-11-01 is the US fall-back day: 25 hours in America/New_York.
    expect(first.periodStart).toBe("2026-11-01T04:00:00.000Z");
    expect(first.periodEnd).toBe("2026-11-02T05:00:00.000Z");
    expect(first.timezone).toBe("America/New_York");
    expect(first.data.metrics.status).toBe("UNAVAILABLE");
    expect(first.missingData.map((item) => item.code)).toContain("NO_ANALYTICS_ACCOUNT");
    expect(first.data.publishing.publishedCount).toBe(0);
    expect(first.link).toBe(`/workspaces/${workspaceId}/channels/${channelId}/reports/${first.id}`);
    const second = await service.generate(owner, body);
    expect(second.id).toBe(first.id);
    expect(await db.channelReport.count({ where: { channelId, periodType: "DAILY" } })).toBe(1);
    expect(
      await db.notificationEvent.count({
        where: { workspaceId, eventType: "CHANNEL_REPORT_READY" },
      }),
    ).toBe(1);

    await expect(
      service.generate(owner, { ...body, periodStartDate: "2026-11-10" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.generate(owner, { channelId, periodType: "WEEKLY", periodStartDate: "2026-11-03" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.generate(outsider, { ...body, channelId })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect((await service.list(viewer, { channelId })).map((item) => item.id)).toContain(first.id);
    expect((await service.get(viewer, first.id)).id).toBe(first.id);
    await expect(service.get(outsider, first.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("schedule tick generates for active channels once and suppresses paused ones", async () => {
    if (!db) return;
    // Tuesday 2026-11-10 12:00 UTC = 07:00 in New York: yesterday and last week have ended.
    clockNow = new Date("2026-11-10T12:00:00.000Z");
    const service = reports();
    await service.runScheduleTick(clockNow);
    const mine = await db.channelReport.findMany({
      where: { channelId: { in: [channelId, pausedChannelId] }, trigger: "SCHEDULED" },
      orderBy: { periodType: "asc" },
    });
    expect(mine.map((item) => [item.channelId, item.periodType, item.localStartDate])).toEqual([
      [channelId, "DAILY", "2026-11-09"],
      [channelId, "WEEKLY", "2026-11-02"],
    ]);
    await service.runScheduleTick(new Date(clockNow.getTime() + 60_000));
    expect(
      await db.channelReport.count({
        where: { channelId: { in: [channelId, pausedChannelId] }, trigger: "SCHEDULED" },
      }),
    ).toBe(2);
    expect(await db.channelReport.count({ where: { channelId: pausedChannelId } })).toBe(0);
  });

  it("strict keyset: more same-timestamp rows than one batch are all consumed across ticks", async () => {
    if (!db) return;
    clockNow = new Date();
    const config: NotificationsConfig = {
      ...DEFAULT_NOTIFICATIONS_CONFIG,
      intakeBatchSize: 3,
      intakeMaxPages: 1,
    };
    const service = notifications(new NotConfiguredNotificationEmail(), config);
    // Fresh cursors at the current settle boundary, then batchSize + 1 rows on one timestamp.
    await db.notificationIntakeCursor.deleteMany({});
    await service.runIntake(clockNow);
    const shared = new Date(clockNow.getTime() - 10_000);
    const ids: string[] = [];
    for (let index = 0; index < config.intakeBatchSize + 1; index += 1)
      ids.push(await outbox(workspaceId, channelId, "PublishFailed", shared));
    const later = new Date(clockNow.getTime() + 60_000);
    let ticks = 0;
    for (; ticks < 50; ticks += 1) {
      const results = await service.runIntake(later);
      const outboxResult = results.find((result) => result.source === "m13.outbox");
      expect(outboxResult?.error).toBeNull();
      expect(outboxResult!.read).toBeLessThanOrEqual(config.intakeBatchSize);
      if (outboxResult!.read === 0) break;
    }
    expect(ticks).toBeGreaterThanOrEqual(2);
    const recorded = await db.notificationEvent.findMany({
      where: { workspaceId, sourceKey: { in: ids.map((id) => `m13:outbox:${id}`) } },
    });
    expect(recorded).toHaveLength(ids.length);
    const cursor = await db.notificationIntakeCursor.findUniqueOrThrow({
      where: { source: "m13.outbox" },
    });
    expect(cursor.afterAt!.getTime()).toBeGreaterThanOrEqual(shared.getTime());
  });

  it("a fresh cursor starts at the settle boundary and ignores older rows unless backfilling", async () => {
    if (!db) return;
    clockNow = new Date(Date.now() + 5 * 60_000);
    const old = await outbox(
      workspaceId,
      channelId,
      "PublishFailed",
      new Date(clockNow.getTime() - 120_000),
    );
    const service = notifications(
      new NotConfiguredNotificationEmail(),
      DEFAULT_NOTIFICATIONS_CONFIG,
    );
    await db.notificationIntakeCursor.deleteMany({});
    await service.runIntake(clockNow);
    const until = new Date(clockNow.getTime() - DEFAULT_NOTIFICATIONS_CONFIG.intakeSettleMs);
    const cursor = await db.notificationIntakeCursor.findUniqueOrThrow({
      where: { source: "m13.outbox" },
    });
    expect(cursor.afterAt?.getTime()).toBe(until.getTime());
    const keyOf = (id: string): Promise<number> =>
      db.notificationEvent.count({ where: { workspaceId, sourceKey: `m13:outbox:${id}` } });
    expect(await keyOf(old)).toBe(0);

    // A row after the boundary is consumed on the next tick.
    const fresh = await outbox(
      workspaceId,
      channelId,
      "PublishFailed",
      new Date(until.getTime() + 1_000),
    );
    await service.runIntake(new Date(clockNow.getTime() + 60_000));
    expect(await keyOf(fresh)).toBe(1);
    expect(await keyOf(old)).toBe(0);

    // An explicit backfill from an empty cursor picks the older row up.
    await db.notificationIntakeCursor.deleteMany({});
    const backfiller = notifications();
    for (let tick = 0; tick < 20 && (await keyOf(old)) === 0; tick += 1)
      await backfiller.runIntake(new Date(clockNow.getTime() + 60_000));
    expect(await keyOf(old)).toBe(1);
  });

  it("insights in a report use a period-bounded read with exact totals", async () => {
    if (!db) return;
    const period = {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-02T00:00:00.000Z"),
    };
    const insight = (createdAt: Date): Promise<unknown> =>
      db.performanceInsightReport.create({
        data: {
          workspaceId,
          channelId,
          periodStart: new Date("2026-09-01"),
          periodEnd: new Date("2026-09-07"),
          comparisonStart: new Date("2026-08-25"),
          comparisonEnd: new Date("2026-08-31"),
          status: "INSUFFICIENT_DATA",
          kpis: [],
          dimensionSummaries: [],
          aiStatus: "NOT_CONFIGURED",
          limitations: [],
          snapshotIds: [],
          createdByUserId: ownerId,
          createdAt,
        },
      });
    await insight(new Date("2026-10-01T01:00:00.000Z"));
    await insight(new Date("2026-10-01T02:00:00.000Z"));
    await insight(new Date("2026-10-01T03:00:00.000Z"));
    await insight(new Date("2026-10-02T00:00:00.000Z")); // outside [from, to)
    const result = await performance().listChannelInsightsBetween(owner, {
      channelId,
      ...period,
      reportLimit: 2,
      recommendationLimit: 5,
    });
    expect(result.reportTotal).toBe(3);
    expect(result.reports.map((report) => report.createdAt)).toEqual([
      "2026-10-01T01:00:00.000Z",
      "2026-10-01T02:00:00.000Z",
    ]);
    expect(result.recommendationTotal).toBe(0);
    await expect(
      performance().listChannelInsightsBetween(outsider, {
        channelId,
        ...period,
        reportLimit: 2,
        recommendationLimit: 5,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a report and its CHANNEL_REPORT_READY event commit together", async () => {
    if (!db) return;
    clockNow = new Date("2026-11-10T12:00:00.000Z");
    const body = { channelId, periodType: "DAILY", periodStartDate: "2026-11-04" };
    const failing = {
      recordEvents: async (): Promise<number> => {
        throw new Error("event insert failed");
      },
    } as unknown as NotificationsService;
    await expect(reports(failing).generate(editor, body)).rejects.toThrow("event insert failed");
    const where = { channelId, periodType: "DAILY" as const, localStartDate: "2026-11-04" };
    expect(await db.channelReport.count({ where })).toBe(0);

    const report = await reports().generate(editor, body);
    expect(await db.channelReport.count({ where })).toBe(1);
    expect(
      await db.notificationEvent.count({
        where: { workspaceId, sourceKey: `m17:channel-report:${report.id}` },
      }),
    ).toBe(1);
  });
});
