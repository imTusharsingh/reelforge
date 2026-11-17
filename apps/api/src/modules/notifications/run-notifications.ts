import { Inject, Injectable } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { AutonomyService } from "../autonomy/autonomy.service.js";
import { NotificationsService } from "./notifications.service.js";
import type { NotificationEventInput } from "./notifications.sources.js";

/** Worker-owned polling of durable V3 boundaries; M17 deduplicates delivery across restarts. */
@Injectable()
export class RunNotifications {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly autonomy: AutonomyService,
    private readonly notifications: NotificationsService,
  ) {}
  public async tick(now: Date = new Date()): Promise<void> {
    const workspaces = await this.db.workspace.findMany({ where: { archivedAt: null } });
    for (const workspace of workspaces) {
      const actor = await this.db.workspaceMembership.findFirst({
        where: { workspaceId: workspace.id, role: { in: ["OWNER", "EDITOR"] } },
      });
      if (!actor) continue;
      await this.workspace(
        { workspaceId: workspace.id, userId: actor.userId, role: actor.role },
        now,
      );
    }
  }
  private async workspace(context: WorkspaceContext, now: Date): Promise<void> {
    const db = this.autonomy.store.scoped(context);
    const runs = await db.videoRun.findMany({
      where: { state: { in: ["AWAITING_APPROVAL", "PAUSED_BUDGET", "NEEDS_HUMAN", "FAILED"] } },
    });
    const events: NotificationEventInput[] = [];
    for (const run of runs) {
      await this.autonomy.settle(context, run);
      const current = await this.autonomy.store.get(context, run.id);
      if (current.state === "SCHEDULED" || current.pauseReason === "HUMAN_REJECTED") continue;
      events.push({
        workspaceId: context.workspaceId,
        channelId: run.channelId,
        eventType: "VIDEO_RUN_APPROVAL_REQUESTED",
        sourceModule: "M17",
        sourceKey: `v8:approval:${run.id}:${current.revision}`,
        correlationId: run.correlationId,
        subjectType: "VideoRun",
        subjectId: run.id,
        link: `/runs/${run.id}`,
        payload: { state: current.state, pauseReason: current.pauseReason },
        occurredAt: now,
      });
    }
    const channels = new Set(events.map((event) => event.channelId));
    for (const channelId of channels) {
      if (channelId === null) continue;
      const count = events.filter(
        (event) =>
          event.channelId === channelId && event.eventType === "VIDEO_RUN_APPROVAL_REQUESTED",
      ).length;
      events.push({
        workspaceId: context.workspaceId,
        channelId,
        eventType: "VIDEO_RUN_DAILY_DIGEST",
        sourceModule: "M17",
        sourceKey: `v8:digest:${channelId}:${now.toISOString().slice(0, 10)}`,
        correlationId: null,
        subjectType: "Channel",
        subjectId: channelId,
        link: "/approvals",
        payload: { pending: count },
        occurredAt: now,
      });
    }
    await this.notifications.recordEvents(events);
  }
}
