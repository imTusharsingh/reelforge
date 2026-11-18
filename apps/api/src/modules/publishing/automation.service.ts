import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import { PublishingPackageSchema, type PublishingPackage } from "@reelforge/contracts";
import type { PrismaClient } from "@reelforge/database";
import { RunsStore } from "../runs/runs.store.js";
import type { Context, Run } from "../runs/runs.types.js";
import { reconnectRequired } from "./automation-client.js";
import { PublishingService } from "./publishing.service.js";
import { AutomationSlots, type AutoSlot } from "./automation-slots.js";
import { approvalMatchesCritic } from "./approval-evidence.js";

@Injectable()
export class PublishingAutomation {
  public constructor(
    @Inject("DATABASE") private readonly db: PrismaClient,
    private readonly runs: RunsStore,
    private readonly slots: AutomationSlots,
    private readonly publishing: PublishingService,
  ) {}
  public async prepare(context: Context, id: string, now = new Date()): Promise<AutoSlot> {
    this.enabled();
    this.editor(context);
    const run = await this.runs.get(context, id);
    await this.approval(context, run);
    const step = await this.runs.scoped(context).videoRunStep.findFirst({
      where: { runId: id, key: "CRITIC", state: "SUCCEEDED" },
      orderBy: { attempt: "desc" },
    });
    const assembly = await this.runs.scoped(context).videoRunStep.findFirst({
      where: { runId: id, key: "ASSEMBLING", state: "SUCCEEDED" },
      orderBy: { attempt: "desc" },
    });
    const output = step?.output;
    const result =
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as { result?: { packaging?: Record<string, unknown> } }).result?.packaging
        : null;
    const packaged = PublishingPackageSchema.safeParse(
      result
        ? { ...result, videoRunId: run.id, criticStepId: step?.id, assemblyStepId: assembly?.id }
        : null,
    );
    if (!packaged.success)
      throw new ConflictException(
        "Publishing package is unavailable or incompatible with this run",
      );
    const slot = await this.slots.reserve(context, run, packaged.data, now);
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
      videoRunId: packaged.videoRunId,
      criticStepId: packaged.criticStepId,
      assemblyStepId: packaged.assemblyStepId,
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
      orderBy: { sequence: "desc" },
    });
    const critic = await this.runs.scoped(context).videoRunStep.findFirst({
      where: { runId: run.id, key: "CRITIC" },
      orderBy: { attempt: "desc" },
    });
    if (
      !evidence ||
      (evidence.type === "auto_approved" &&
        (run.effectiveAutonomy !== "L3" || run.approvedShortsAtStart < 10))
    )
      throw new ConflictException(
        "Publish requires V8 approval; first ten Shorts require a human tap",
      );
    if (!approvalMatchesCritic(evidence, critic))
      throw new ConflictException("Publish requires approval of the current critic evidence");
  }
  public async dispatch(context: Context, id: string): Promise<void> {
    this.enabled();
    this.editor(context);
    let slot: AutoSlot | null = null;
    try {
      slot = await this.prepare(context, id);
      if (!slot.scheduledPostId || slot.status === "COMPLETE" || slot.status === "NEEDS_HUMAN")
        return;
      const post = await this.publishing.getScheduledPost(context, slot.scheduledPostId);
      const destination = post.destinations[0];
      if (!destination) throw new ConflictException("Publishing destination missing");
      const attempted = destination.latestAttempt !== null;
      let result = attempted
        ? await this.publishing.reconcile(context, destination.id)
        : await this.publishing.publishNow(context, destination.id);
      if (attempted && result.destinations[0]?.status === "FAILED_RETRYABLE")
        result = await this.publishing.retry(context, destination.id);
      const published = result.destinations[0]?.status === "PUBLISHED";
      await this.db.v9PublishSlot.updateMany({
        where: { workspaceId: context.workspaceId, id: slot.id },
        data: { status: published ? "COMPLETE" : "WAITING", lastError: null },
      });
      if (published) {
        const run = await this.runs.get(context, id);
        if (run.state === "SCHEDULED")
          await this.runs.transition(context, id, run.revision, "PUBLISHED");
      }
    } catch (error) {
      await this.failure(context, id, slot, error);
    }
  }
  private async failure(
    context: Context,
    id: string,
    slot: AutoSlot | null,
    error: unknown,
  ): Promise<void> {
    const reconnect = reconnectRequired(error);
    if (slot)
      await this.db.v9PublishSlot.updateMany({
        where: { workspaceId: context.workspaceId, id: slot.id },
        data: {
          status: reconnect ? "NEEDS_HUMAN" : "WAITING",
          lastError: reconnect ? "RECONNECT_YOUTUBE" : "PREFLIGHT_OR_RECONCILE_REQUIRED",
        },
      });
    if (!reconnect) {
      console.warn("[v9-publishing] preflight or reconciliation blocked", id);
      return;
    }
    await this.runs.mutate(context, id, "publishing_reconnect_required", async (db, run) => {
      if (run.state !== "SCHEDULED") throw new ConflictException("Run changed");
      // #131 explicitly requires a reconnect hold from the scheduled boundary; V1 remains frozen.
      await db.videoRun.updateMany({
        where: { id },
        data: { state: "NEEDS_HUMAN", effectiveAutonomy: "L2", pauseReason: "RECONNECT_YOUTUBE" },
      });
      return {
        value: null,
        payload: { reason: "RECONNECT_YOUTUBE", from: "SCHEDULED", to: "NEEDS_HUMAN" },
      };
    });
  }
  public async retry(context: Context, id: string): Promise<void> {
    this.enabled();
    this.editor(context);
    await this.runs.mutate(context, id, "publishing_reconnect_acknowledged", async (db, run) => {
      if (run.state !== "NEEDS_HUMAN" || run.pauseReason !== "RECONNECT_YOUTUBE")
        throw new ConflictException("No reconnect hold");
      await db.videoRun.updateMany({
        where: { id },
        data: { state: "SCHEDULED", pauseReason: null },
      });
      return { value: null, payload: { from: "NEEDS_HUMAN", to: "SCHEDULED" } };
    });
    await this.db.v9PublishSlot.updateMany({
      where: { workspaceId: context.workspaceId, runId: id },
      data: { status: "WAITING", lastError: null },
    });
    await this.dispatch(context, id);
  }
  public async tick(_now: Date): Promise<void> {
    void _now;
    if (!pipelineV2Enabled()) return;
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
        where: { state: "SCHEDULED" },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      for (const run of runs) {
        await this.dispatch(context, run.id);
      }
    }
  }
  private enabled(): void {
    if (!pipelineV2Enabled()) throw new ConflictException("pipeline.v2 is disabled");
  }
  private editor(context: Context): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor required");
  }
}
