import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_EVENT_TYPES,
  audienceIncludes,
  catalogEntry,
  isNotificationEventType,
  type NotificationAudience,
  type NotificationEventType,
  type NotificationSeverity,
} from "./notifications.catalog.js";
import {
  NOTIFICATIONS_CLOCK,
  NOTIFICATIONS_CONFIG,
  NOTIFICATION_EMAIL_PORT,
  NotificationEmailError,
  deliveryBackoffMs,
  type NotificationEmailPort,
  type NotificationsConfig,
} from "./notifications.ports.js";
import {
  NotificationIntakeSources,
  type NotificationEventInput,
  type NotificationIntakeSource,
} from "./notifications.sources.js";
import {
  parseListNotificationsQuery,
  parsePutPreferences,
  parseUuid,
} from "./notifications.validation.js";

export const EMAIL_CHANNEL = "EMAIL";

export type NotificationView = Readonly<{
  id: string;
  eventId: string;
  eventType: string;
  severity: NotificationSeverity | null;
  channelId: string | null;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationPreferenceView = Readonly<{
  eventType: NotificationEventType;
  sourceModule: string;
  description: string;
  audience: NotificationAudience;
  inApp: boolean;
  email: boolean;
  isDefault: boolean;
}>;

export type NotificationDeliveryView = Readonly<{
  id: string;
  eventId: string;
  eventType: string;
  channel: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type IntakeSourceResult = Readonly<{
  source: string;
  read: number;
  recorded: number;
  error: string | null;
}>;

export type FanoutResult = Readonly<{
  events: number;
  notifications: number;
  deliveries: number;
  errors: readonly string[];
}>;

export type DeliveryResult = Readonly<{
  sent: number;
  retryWait: number;
  failed: number;
  skippedNotConfigured: number;
  unknownOutcome: number;
}>;

type Member = Readonly<{
  membershipId: string;
  userId: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  email: string;
}>;

const RETRYABLE_DELIVERY_STATES = ["FAILED", "SKIPPED_NOT_CONFIGURED"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function asPayload(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class NotificationsService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly sources: NotificationIntakeSources,
    @Inject(NOTIFICATION_EMAIL_PORT) private readonly email: NotificationEmailPort,
    @Inject(NOTIFICATIONS_CLOCK) private readonly clock: () => Date,
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
  ) {}

  // ---------------------------------------------------------------- in-app (T02)

  public async listMine(
    context: WorkspaceContext,
    query: unknown,
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    const parsed = parseListNotificationsQuery(query);
    const member = await this.memberFor(context);
    const where: Prisma.NotificationWhereInput = {
      workspaceId: context.workspaceId,
      recipientMemberId: member.membershipId,
      ...(parsed.unreadOnly ? { readAt: null } : {}),
      ...(parsed.before === null ? {} : { createdAt: { lt: parsed.before } }),
    };
    const [items, unreadCount] = await Promise.all([
      this.db.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: parsed.limit,
      }),
      this.db.notification.count({
        where: {
          workspaceId: context.workspaceId,
          recipientMemberId: member.membershipId,
          readAt: null,
        },
      }),
    ]);
    return { items: items.map((item) => this.presentNotification(item)), unreadCount };
  }

  public async markRead(
    context: WorkspaceContext,
    notificationId: string,
  ): Promise<NotificationView> {
    const id = parseUuid(notificationId, "notificationId");
    const member = await this.memberFor(context);
    const scope = {
      workspaceId: context.workspaceId,
      recipientMemberId: member.membershipId,
      id,
    };
    // First read wins; marking an already-read notification is a no-op.
    await this.db.notification.updateMany({
      where: { ...scope, readAt: null },
      data: { readAt: this.clock() },
    });
    const notification = await this.db.notification.findFirst({ where: scope });
    if (!notification) throw new NotFoundException("Notification not found");
    return this.presentNotification(notification);
  }

  public async markAllRead(context: WorkspaceContext): Promise<{ updated: number }> {
    const member = await this.memberFor(context);
    const updated = await this.db.notification.updateMany({
      where: {
        workspaceId: context.workspaceId,
        recipientMemberId: member.membershipId,
        readAt: null,
      },
      data: { readAt: this.clock() },
    });
    return { updated: updated.count };
  }

  // ---------------------------------------------------------------- preferences (T01/T06)

  public async getPreferences(context: WorkspaceContext): Promise<NotificationPreferenceView[]> {
    const member = await this.memberFor(context);
    return this.preferencesFor(context.workspaceId, member.membershipId);
  }

  public async putPreferences(
    context: WorkspaceContext,
    body: unknown,
  ): Promise<NotificationPreferenceView[]> {
    const request = parsePutPreferences(body);
    const member = await this.memberFor(context);
    await this.db.$transaction(
      request.preferences.map((preference) =>
        this.db.notificationPreference.upsert({
          where: {
            workspaceId_recipientMemberId_eventType: {
              workspaceId: context.workspaceId,
              recipientMemberId: member.membershipId,
              eventType: preference.eventType,
            },
          },
          create: {
            workspaceId: context.workspaceId,
            recipientMemberId: member.membershipId,
            eventType: preference.eventType,
            inApp: preference.inApp,
            email: preference.email,
          },
          update: { inApp: preference.inApp, email: preference.email },
        }),
      ),
    );
    return this.preferencesFor(context.workspaceId, member.membershipId);
  }

  // ---------------------------------------------------------------- deliveries (T03/T06)

  public async listMyDeliveries(context: WorkspaceContext): Promise<NotificationDeliveryView[]> {
    const member = await this.memberFor(context);
    const deliveries = await this.db.notificationDelivery.findMany({
      where: { workspaceId: context.workspaceId, recipientMemberId: member.membershipId },
      include: { event: { select: { eventType: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return deliveries.map((delivery) => this.presentDelivery(delivery));
  }

  /** Re-queues one of my FAILED or SKIPPED_NOT_CONFIGURED deliveries with a fresh attempt budget. */
  public async retryDelivery(
    context: WorkspaceContext,
    deliveryId: string,
  ): Promise<NotificationDeliveryView> {
    const id = parseUuid(deliveryId, "deliveryId");
    const member = await this.memberFor(context);
    const scope = {
      workspaceId: context.workspaceId,
      recipientMemberId: member.membershipId,
      id,
    };
    const existing = await this.db.notificationDelivery.findFirst({ where: scope });
    if (!existing) throw new NotFoundException("Delivery not found");
    const updated = await this.db.notificationDelivery.updateMany({
      where: { ...scope, status: { in: [...RETRYABLE_DELIVERY_STATES] } },
      data: {
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: this.clock(),
        leaseExpiresAt: null,
      },
    });
    if (updated.count === 0)
      throw new ConflictException(`Delivery in state ${existing.status} cannot be retried`);
    const delivery = await this.db.notificationDelivery.findFirstOrThrow({
      where: scope,
      include: { event: { select: { eventType: true } } },
    });
    return this.presentDelivery(delivery);
  }

  // ---------------------------------------------------------------- intake + fan-out (worker)

  /**
   * Reads every source from its persisted cursor and records typed notification events. The
   * cursor moves with a compare-and-set in the same transaction as the inserts, so two workers
   * cannot both advance it, and `skipDuplicates` on `(workspaceId, sourceKey)` makes any
   * redelivered row a no-op.
   */
  public async runIntake(now: Date = this.clock()): Promise<IntakeSourceResult[]> {
    const until = new Date(now.getTime() - this.config.intakeSettleMs);
    const results: IntakeSourceResult[] = [];
    for (const source of this.sources.all()) {
      try {
        results.push(await this.intakeSource(source, until));
      } catch (error) {
        results.push({ source: source.key, read: 0, recorded: 0, error: errorMessage(error) });
      }
    }
    return results;
  }

  /** Records M17's own events (e.g. CHANNEL_REPORT_READY). Duplicate source keys are ignored. */
  public async recordEvents(events: readonly NotificationEventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const created = await this.db.notificationEvent.createMany({
      data: events.map((event) => this.eventRow(event)),
      skipDuplicates: true,
    });
    return created.count;
  }

  /**
   * Fans pending events out to workspace members, applying the catalog audience and each
   * member's preferences (defaults when no row exists). Notification and delivery inserts use
   * per-recipient dedupe keys with `skipDuplicates`, so re-running after a crash is a no-op.
   */
  public async fanOutPending(now: Date = this.clock()): Promise<FanoutResult> {
    const events = await this.db.notificationEvent.findMany({
      where: { fanoutStatus: "PENDING" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: this.config.fanoutBatchSize,
    });
    const members = new Map<string, Member[]>();
    let notifications = 0;
    let deliveries = 0;
    const errors: string[] = [];
    for (const event of events) {
      let recipients = members.get(event.workspaceId);
      if (!recipients) {
        recipients = await this.workspaces.listMembers(event.workspaceId);
        members.set(event.workspaceId, recipients);
      }
      try {
        const result = await this.fanOutEvent(event, recipients, now);
        notifications += result.notifications;
        deliveries += result.deliveries;
      } catch (error) {
        // Left PENDING and retried on the next tick (e.g. a member removed mid-fan-out).
        errors.push(`${event.id}: ${errorMessage(error)}`);
      }
    }
    return { events: events.length, notifications, deliveries, errors };
  }

  /**
   * Processes due email deliveries. With the default NOT_CONFIGURED port every due delivery is
   * recorded as SKIPPED_NOT_CONFIGURED (never a fake SENT). A configured port gets bounded
   * retries with exponential backoff; a lease that expires mid-send is recorded as FAILED with
   * `UNKNOWN_OUTCOME` (visible and manually retryable) instead of being resent automatically.
   */
  public async processDueDeliveries(now: Date = this.clock()): Promise<DeliveryResult> {
    let sent = 0;
    let retryWait = 0;
    let failed = 0;
    let skippedNotConfigured = 0;
    const stale = await this.db.notificationDelivery.updateMany({
      where: { status: "SENDING", leaseExpiresAt: { lt: now } },
      data: {
        status: "FAILED",
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastErrorCode: "UNKNOWN_OUTCOME",
        lastErrorMessage: "The send did not report back before its lease expired",
      },
    });
    const due = await this.db.notificationDelivery.findMany({
      where: { status: { in: ["PENDING", "RETRY_WAIT"] }, nextAttemptAt: { lte: now } },
      include: { event: true, recipient: { select: { user: { select: { email: true } } } } },
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
      take: this.config.deliveryBatchSize,
    });
    for (const delivery of due) {
      const guard = {
        workspaceId: delivery.workspaceId,
        id: delivery.id,
        status: delivery.status,
        attempts: delivery.attempts,
      };
      if (!this.email.isConfigured()) {
        const skipped = await this.db.notificationDelivery.updateMany({
          where: guard,
          data: {
            status: "SKIPPED_NOT_CONFIGURED",
            nextAttemptAt: null,
            lastErrorCode: "EMAIL_NOT_CONFIGURED",
            lastErrorMessage: "No email sender is configured; in-app notification only",
          },
        });
        skippedNotConfigured += skipped.count;
        continue;
      }
      const attempts = delivery.attempts + 1;
      const claimed = await this.db.notificationDelivery.updateMany({
        where: guard,
        data: {
          status: "SENDING",
          attempts,
          leaseExpiresAt: new Date(now.getTime() + this.config.deliveryLeaseMs),
        },
      });
      if (claimed.count === 0) continue;
      const sendingGuard = {
        workspaceId: delivery.workspaceId,
        id: delivery.id,
        status: "SENDING" as const,
        attempts,
      };
      const entry = isNotificationEventType(delivery.event.eventType)
        ? catalogEntry(delivery.event.eventType)
        : null;
      const payload = asPayload(delivery.event.payload);
      try {
        if (entry === null)
          throw new NotificationEmailError("Unknown event type", "UNKNOWN_EVENT_TYPE", false);
        const result = await this.email.send({
          to: delivery.recipient.user.email,
          subject: entry.title(payload),
          text:
            delivery.event.link === null
              ? entry.body(payload)
              : `${entry.body(payload)}\n\nOpen in ReelForge: ${delivery.event.link}`,
          idempotencyKey: delivery.id,
        });
        const done = await this.db.notificationDelivery.updateMany({
          where: sendingGuard,
          data: {
            status: "SENT",
            sentAt: this.clock(),
            providerMessageId: result.providerMessageId,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        sent += done.count;
      } catch (error) {
        const retryable = error instanceof NotificationEmailError ? error.retryable : true;
        const code = error instanceof NotificationEmailError ? error.code : "EMAIL_SEND_FAILED";
        const exhausted = attempts >= delivery.maxAttempts;
        const next = retryable && !exhausted;
        const updated = await this.db.notificationDelivery.updateMany({
          where: sendingGuard,
          data: {
            status: next ? "RETRY_WAIT" : "FAILED",
            leaseExpiresAt: null,
            nextAttemptAt: next
              ? new Date(now.getTime() + deliveryBackoffMs(this.config, attempts))
              : null,
            lastErrorCode: code,
            lastErrorMessage: errorMessage(error),
          },
        });
        if (next) retryWait += updated.count;
        else failed += updated.count;
      }
    }
    return { sent, retryWait, failed, skippedNotConfigured, unknownOutcome: stale.count };
  }

  // ---------------------------------------------------------------- internals

  private async intakeSource(
    source: NotificationIntakeSource,
    until: Date,
  ): Promise<IntakeSourceResult> {
    let read = 0;
    let recorded = 0;
    await this.db.notificationIntakeCursor.createMany({
      data: [{ source: source.key }],
      skipDuplicates: true,
    });
    for (let page = 0; page < this.config.intakeMaxPages; page += 1) {
      const cursor = await this.db.notificationIntakeCursor.findUniqueOrThrow({
        where: { source: source.key },
      });
      const after =
        cursor.afterAt !== null && cursor.afterId !== null
          ? { at: cursor.afterAt, id: cursor.afterId }
          : null;
      const items = await source.read(after, until, this.config.intakeBatchSize);
      if (items.length === 0) break;
      const last = items[items.length - 1]!.cursor;
      if (after !== null && last.at.getTime() === after.at.getTime() && last.id === after.id) break;
      if (
        after !== null &&
        items.length >= this.config.intakeBatchSize &&
        last.at.getTime() === after.at.getTime()
      )
        return {
          source: source.key,
          read,
          recorded,
          error: "More rows share one timestamp than fit in a batch; raise intakeBatchSize",
        };
      const events = items.flatMap((item) => (item.event === null ? [] : [item.event]));
      const inserted = await this.db.$transaction(async (tx) => {
        const moved = await tx.notificationIntakeCursor.updateMany({
          where: { source: source.key, afterAt: cursor.afterAt, afterId: cursor.afterId },
          data: { afterAt: last.at, afterId: last.id },
        });
        if (moved.count === 0) return null;
        if (events.length === 0) return 0;
        // Skip events of workspaces deleted since the read, so one deletion cannot wedge a page.
        const live = new Set(
          (
            await tx.workspace.findMany({
              where: { id: { in: [...new Set(events.map((event) => event.workspaceId))] } },
              select: { id: true },
            })
          ).map((workspace) => workspace.id),
        );
        const rows = events.filter((event) => live.has(event.workspaceId));
        if (rows.length === 0) return 0;
        const created = await tx.notificationEvent.createMany({
          data: rows.map((event) => this.eventRow(event)),
          skipDuplicates: true,
        });
        return created.count;
      });
      if (inserted === null) break; // another worker advanced this cursor
      read += items.length;
      recorded += inserted;
      if (items.length < this.config.intakeBatchSize) break;
    }
    return { source: source.key, read, recorded, error: null };
  }

  private async fanOutEvent(
    event: Readonly<{
      id: string;
      workspaceId: string;
      channelId: string | null;
      eventType: string;
      sourceKey: string;
      link: string | null;
      payload: Prisma.JsonValue;
    }>,
    members: readonly Member[],
    now: Date,
  ): Promise<{ notifications: number; deliveries: number }> {
    if (!isNotificationEventType(event.eventType)) {
      await this.db.notificationEvent.updateMany({
        where: { workspaceId: event.workspaceId, id: event.id, fanoutStatus: "PENDING" },
        data: { fanoutStatus: "DONE", fannedOutAt: now },
      });
      return { notifications: 0, deliveries: 0 };
    }
    const entry = NOTIFICATION_EVENT_CATALOG[event.eventType];
    const payload = asPayload(event.payload);
    const recipients = members.filter((member) => audienceIncludes(entry.audience, member.role));
    const preferences = await this.db.notificationPreference.findMany({
      where: {
        workspaceId: event.workspaceId,
        eventType: event.eventType,
        recipientMemberId: { in: recipients.map((member) => member.membershipId) },
      },
    });
    const byMember = new Map(preferences.map((row) => [row.recipientMemberId, row]));
    const inApp: Prisma.NotificationCreateManyInput[] = [];
    const email: Prisma.NotificationDeliveryCreateManyInput[] = [];
    for (const member of recipients) {
      const preference = byMember.get(member.membershipId) ?? entry.defaults;
      if (preference.inApp)
        inApp.push({
          workspaceId: event.workspaceId,
          recipientMemberId: member.membershipId,
          eventId: event.id,
          eventType: event.eventType,
          channelId: event.channelId,
          title: entry.title(payload),
          body: entry.body(payload),
          link: event.link,
          dedupeKey: event.sourceKey,
        });
      if (preference.email)
        email.push({
          workspaceId: event.workspaceId,
          recipientMemberId: member.membershipId,
          eventId: event.id,
          channel: EMAIL_CHANNEL,
          status: "PENDING",
          dedupeKey: event.sourceKey,
          maxAttempts: this.config.deliveryMaxAttempts,
          nextAttemptAt: now,
        });
    }
    return this.db.$transaction(async (tx) => {
      const marked = await tx.notificationEvent.updateMany({
        where: { workspaceId: event.workspaceId, id: event.id, fanoutStatus: "PENDING" },
        data: { fanoutStatus: "DONE", fannedOutAt: now },
      });
      if (marked.count === 0) return { notifications: 0, deliveries: 0 };
      const notifications =
        inApp.length === 0
          ? 0
          : (await tx.notification.createMany({ data: inApp, skipDuplicates: true })).count;
      const deliveries =
        email.length === 0
          ? 0
          : (await tx.notificationDelivery.createMany({ data: email, skipDuplicates: true })).count;
      return { notifications, deliveries };
    });
  }

  private eventRow(event: NotificationEventInput): Prisma.NotificationEventCreateManyInput {
    return {
      workspaceId: event.workspaceId,
      channelId: event.channelId,
      eventType: event.eventType,
      sourceModule: event.sourceModule,
      sourceKey: event.sourceKey,
      correlationId: event.correlationId,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      link: event.link,
      payload: event.payload as Prisma.InputJsonValue,
      occurredAt: event.occurredAt,
    };
  }

  private async preferencesFor(
    workspaceId: string,
    membershipId: string,
  ): Promise<NotificationPreferenceView[]> {
    const rows = await this.db.notificationPreference.findMany({
      where: { workspaceId, recipientMemberId: membershipId },
    });
    const byType = new Map(rows.map((row) => [row.eventType, row]));
    return NOTIFICATION_EVENT_TYPES.map((eventType) => {
      const entry = NOTIFICATION_EVENT_CATALOG[eventType];
      const row = byType.get(eventType);
      return {
        eventType,
        sourceModule: entry.sourceModule,
        description: entry.description,
        audience: entry.audience,
        inApp: row?.inApp ?? entry.defaults.inApp,
        email: row?.email ?? entry.defaults.email,
        isDefault: row === undefined,
      };
    });
  }

  private async memberFor(context: WorkspaceContext): Promise<Member> {
    const members = await this.workspaces.listMembers(context.workspaceId);
    const member = members.find((candidate) => candidate.userId === context.userId);
    if (!member) throw new ForbiddenException("Workspace access denied");
    return member;
  }

  private presentNotification(
    notification: Prisma.NotificationGetPayload<Record<string, never>>,
  ): NotificationView {
    return {
      id: notification.id,
      eventId: notification.eventId,
      eventType: notification.eventType,
      severity: isNotificationEventType(notification.eventType)
        ? NOTIFICATION_EVENT_CATALOG[notification.eventType].severity
        : null,
      channelId: notification.channelId,
      title: notification.title,
      body: notification.body,
      link: notification.link,
      readAt: notification.readAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
    };
  }

  private presentDelivery(
    delivery: Prisma.NotificationDeliveryGetPayload<{
      include: { event: { select: { eventType: true } } };
    }>,
  ): NotificationDeliveryView {
    return {
      id: delivery.id,
      eventId: delivery.eventId,
      eventType: delivery.event.eventType,
      channel: delivery.channel,
      status: delivery.status,
      attempts: delivery.attempts,
      maxAttempts: delivery.maxAttempts,
      nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
      lastErrorCode: delivery.lastErrorCode,
      lastErrorMessage: delivery.lastErrorMessage,
      sentAt: delivery.sentAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
      updatedAt: delivery.updatedAt.toISOString(),
    };
  }
}
