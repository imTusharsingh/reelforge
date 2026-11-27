import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { PublishingPackageSchema, type PublishingPackage } from "@reelforge/contracts";
import type { Prisma, PrismaClient } from "@reelforge/database";
import { youTubeSlotElapsed } from "../social-accounts/scheduled-youtube.js";
import { RunsStore } from "../runs/runs.store.js";
import type { Context, Run } from "../runs/runs.types.js";
import { reconnectRequired } from "./automation-client.js";
import { PublishingService } from "./publishing.service.js";
import type { PublishingDestinationView, ScheduledPostView } from "./publishing.types.js";
import { markElapsedSlotMissed, type PartialYouTubeProbe } from "./automation-missed-slot.js";
import { AutomationSlots, type AutoSlot } from "./automation-slots.js";

const reconnectReason = "RECONNECT_YOUTUBE";
class ReconnectRace extends Error {}
const confirmedSlot = {
  OR: [
    { status: "COMPLETE" },
    {
      status: { not: "DRY_RUN" },
      post: {
        is: { destinations: { some: { status: "PUBLISHED", remotePostId: { not: null } } } },
      },
    },
  ],
} satisfies Prisma.V9PublishSlotWhereInput;

@Injectable()
export class PublishingAutomation {
  public constructor(
    @Inject("DATABASE") private readonly db: PrismaClient,
    private readonly runs: RunsStore,
    private readonly slots: AutomationSlots,
    private readonly publishing: PublishingService,
  ) {}
  public async prepare(context: Context, id: string, now = new Date()): Promise<AutoSlot> {
    this.editor(context);
    const run = await this.runs.get(context, id);
    await this.approval(context, run);
    const step = await this.runs.scoped(context).videoRunStep.findFirst({
      where: { runId: id, key: "PACKAGING", state: "SUCCEEDED" },
      orderBy: { attempt: "desc" },
    });
    const output = step?.output;
    const packaged = PublishingPackageSchema.parse(
      output && typeof output === "object" && !Array.isArray(output) ? output.result : null,
    );
    const slot = await this.slots.reserve(context, run, packaged, now);
    if (slot.scheduledPostId) return slot;
    const post = await this.publishing.createScheduledPost(
      context,
      this.postInput(run, slot, PublishingPackageSchema.parse(slot.package)),
    );
    await this.db.v9PublishSlot.updateMany({
      where: { workspaceId: context.workspaceId, id: slot.id, scheduledPostId: null },
      data: { scheduledPostId: post.id },
    });
    return { ...slot, scheduledPostId: post.id };
  }
  private postInput(run: Run, slot: AutoSlot, packaged: PublishingPackage): unknown {
    const disclosureText = "This Short contains AI-generated video and audio.";
    return {
      clientRequestId: run.id,
      channelId: run.channelId,
      renderJobId: packaged.renderJobId,
      qualityReviewRunId: packaged.qualityReviewRunId,
      scheduledAt: slot.scheduledAt.toISOString(),
      disclosure: {
        decision: "DISCLOSE",
        disclosureText,
        reason: "ReelForge AI disclosure is always enabled",
      },
      destinations: [
        {
          platform: "YOUTUBE",
          socialAccountId: slot.socialAccountId,
          metadata: {
            platform: "YOUTUBE",
            title: packaged.title,
            description: `${packaged.description}\n\n${disclosureText}`,
            tags: packaged.tags,
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
          },
        },
      ],
    };
  }
  private async approval(context: Context, run: Run): Promise<void> {
    if (run.state !== "SCHEDULED" || run.pauseReason !== null)
      throw new ConflictException("Run has no current V8 approval");
    const evidence = await this.runs.scoped(context).runEvent.findFirst({
      where: { runId: run.id, type: { in: ["approved", "auto_approved"] } },
    });
    if (
      !evidence ||
      (evidence.type === "auto_approved" &&
        (run.effectiveAutonomy !== "L3" || run.approvedShortsAtStart < 10))
    )
      throw new ConflictException(
        "Publish requires V8 approval; first ten Shorts require a human tap",
      );
  }
  public async dispatch(context: Context, id: string): Promise<void> {
    this.editor(context);
    let slot: AutoSlot | null = null;
    try {
      const current = await this.runs.get(context, id);
      if (current.state === "NEEDS_HUMAN" && current.pauseReason === reconnectReason) {
        await this.finishPublishedRun(context, id);
        return;
      }
      slot = await this.prepare(context, id);
      if (slot.status === "COMPLETE") {
        await this.finishPublishedRun(context, id);
        return;
      }
      if (
        !slot.scheduledPostId ||
        ["DRY_RUN", "MISSED"].includes(slot.status) ||
        slot.status === "NEEDS_HUMAN"
      )
        return;
      const post = await this.publishing.getScheduledPost(context, slot.scheduledPostId);
      const destination = post.destinations[0];
      if (!destination) throw new ConflictException("Publishing destination missing");
      const result = await this.uploadOrReconcile(context, slot, destination);
      if (!result) return;
      const published = result.destinations[0]?.status === "PUBLISHED";
      if (published && result.dryRun) {
        await this.recordDryRun(context, id, slot.id);
        return;
      }
      await this.db.v9PublishSlot.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id: slot.id,
          status: {
            notIn: published ? ["DRY_RUN"] : ["COMPLETE", "DRY_RUN", "MISSED", "NEEDS_HUMAN"],
          },
        },
        data: { status: published ? "COMPLETE" : "WAITING", lastError: null },
      });
      if (published) await this.finishPublishedRun(context, id);
    } catch (error) {
      await this.failure(context, id, slot, error);
    }
  }
  private async finishPublishedRun(context: Context, id: string): Promise<void> {
    const run = await this.runs.get(context, id);
    if (run.state === "SCHEDULED") {
      await this.runs.transition(context, id, run.revision, "PUBLISHED");
    } else if (run.state === "NEEDS_HUMAN" && run.pauseReason === reconnectReason) {
      await this.runs
        .mutate(context, id, "transition", async (db, current, tx) => {
          if (current.state !== "NEEDS_HUMAN" || current.pauseReason !== reconnectReason)
            throw new ReconnectRace();
          const complete = await tx.v9PublishSlot.findFirst({
            where: { workspaceId: context.workspaceId, runId: id, ...confirmedSlot },
          });
          if (!complete) throw new ReconnectRace();
          if (complete.status !== "COMPLETE") {
            await tx.v9PublishSlot.updateMany({
              where: {
                workspaceId: context.workspaceId,
                id: complete.id,
                status: { notIn: ["DRY_RUN"] },
              },
              data: { status: "COMPLETE", lastError: null },
            });
          }
          await db.videoRun.updateMany({
            where: { id },
            data: { state: "PUBLISHED", pauseReason: null },
          });
          return { value: null, payload: { from: "NEEDS_HUMAN", to: "PUBLISHED", reason: null } };
        })
        .catch(ignoreReconnectRace);
    }
  }

  private async uploadOrReconcile(
    context: Context,
    slot: AutoSlot,
    destination: PublishingDestinationView,
  ): Promise<ScheduledPostView | null> {
    const elapsed = youTubeSlotElapsed(slot.scheduledAt);
    if (elapsed && (await markElapsedSlotMissed(this.db, context, slot, destination.id)))
      return null;

    // The original post view can predate another worker's upload claim.
    // After the deadline, only a read-only probe is allowed, even if that view had no attempt.
    const reconcile = elapsed || destination.latestAttempt !== null;
    let partial: PartialYouTubeProbe | undefined;
    const result = reconcile
      ? await this.publishing.reconcile(context, destination.id, (probe) => {
          partial = probe;
        })
      : await this.publishing.publishNow(context, destination.id);
    if (reconcile && result.destinations[0]?.status === "FAILED_RETRYABLE") {
      if (!youTubeSlotElapsed(slot.scheduledAt))
        return this.publishing.retry(context, destination.id);
      // An already-dispatched final chunk can still be in flight. Use the grace window for reads.
      if (partial && (await markElapsedSlotMissed(this.db, context, slot, destination.id, partial)))
        return null;
    }
    return result;
  }

  private async recordDryRun(context: Context, id: string, slotId: string): Promise<void> {
    await this.runs.mutate(context, id, "publish_dry_run", async (db, current, tx) => {
      if (current.state === "SCHEDULED") {
        await db.videoRun.updateMany({
          where: { id },
          data: { state: "PUBLISHED", pauseReason: "PUBLISH_DRY_RUN" },
        });
      }
      await tx.v9PublishSlot.updateMany({
        where: { workspaceId: context.workspaceId, id: slotId },
        data: { status: "DRY_RUN", lastError: null },
      });
      return { value: null, payload: { dryRun: true } };
    });
  }
  private async failure(
    context: Context,
    id: string,
    slot: AutoSlot | null,
    error: unknown,
  ): Promise<void> {
    if (reconnectRequired(error)) {
      await this.recordReconnect(context, id, slot);
      return;
    }
    if (slot) {
      const changed = await this.db.v9PublishSlot.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id: slot.id,
          status: { notIn: ["COMPLETE", "DRY_RUN", "MISSED", "NEEDS_HUMAN"] },
        },
        data: { status: "WAITING", lastError: "PREFLIGHT_OR_RECONCILE_REQUIRED" },
      });
      if (changed.count === 0) return;
    }
    console.warn("[v9-publishing] preflight or reconciliation blocked", id);
  }
  private async recordReconnect(
    context: Context,
    id: string,
    slot: AutoSlot | null,
  ): Promise<void> {
    await this.runs
      .mutate(context, id, "publishing_reconnect_required", async (db, run, tx) => {
        if (run.state !== "SCHEDULED" || run.pauseReason !== null) throw new ReconnectRace();
        if (slot) {
          if (
            await tx.v9PublishSlot.findFirst({
              where: { workspaceId: context.workspaceId, id: slot.id, ...confirmedSlot },
            })
          )
            throw new ReconnectRace();
          const changed = await tx.v9PublishSlot.updateMany({
            where: {
              workspaceId: context.workspaceId,
              id: slot.id,
              status: { notIn: ["COMPLETE", "DRY_RUN", "MISSED"] },
            },
            data: { status: "NEEDS_HUMAN", lastError: reconnectReason },
          });
          if (!changed.count) throw new ReconnectRace();
        }
        // V1's transition table is frozen. Reconnect is a specific scheduled boundary.
        await db.videoRun.updateMany({
          where: { id },
          data: { state: "NEEDS_HUMAN", effectiveAutonomy: "L2", pauseReason: reconnectReason },
        });
        return {
          value: null,
          payload: { reason: reconnectReason, from: "SCHEDULED", to: "NEEDS_HUMAN" },
        };
      })
      .catch(ignoreReconnectRace);
  }
  public async retry(context: Context, id: string): Promise<void> {
    this.editor(context);
    await this.runs.mutate(
      context,
      id,
      "publishing_reconnect_acknowledged",
      async (db, run, tx) => {
        if (run.state !== "NEEDS_HUMAN" || run.pauseReason !== reconnectReason)
          throw new ConflictException("No reconnect hold");
        await db.videoRun.updateMany({
          where: { id },
          data: { state: "SCHEDULED", pauseReason: null },
        });
        await tx.v9PublishSlot.updateMany({
          where: { workspaceId: context.workspaceId, runId: id, status: "NEEDS_HUMAN" },
          data: { status: "WAITING", lastError: null },
        });
        return { value: null, payload: { from: "NEEDS_HUMAN", to: "SCHEDULED" } };
      },
    );
    await this.dispatch(context, id);
  }
  public async tick(_now: Date): Promise<void> {
    void _now;
    const workspaces = await this.db.workspace.findMany({ where: { archivedAt: null } });
    for (const workspace of workspaces) {
      const actor = await this.db.workspaceMembership.findFirst({
        where: { workspaceId: workspace.id, role: { in: ["OWNER", "EDITOR"] } },
      });
      if (!actor) continue;
      const context: Context = {
        workspaceId: workspace.id,
        userId: actor.userId,
        role: actor.role,
      };
      const runs = await this.runs.scoped(context).videoRun.findMany({
        where: {
          OR: [
            { state: "SCHEDULED", v9Slot: { isNot: { status: "MISSED" } } },
            {
              state: "NEEDS_HUMAN",
              pauseReason: reconnectReason,
              v9Slot: { is: confirmedSlot },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      for (const run of runs) {
        await this.dispatch(context, run.id);
      }
    }
  }
  private editor(context: Context): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor required");
  }
}

function ignoreReconnectRace(error: unknown): void {
  if (!(error instanceof ReconnectRace)) throw error;
}
