import { RunsArtifacts } from "./runs.artifacts.js";
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { autonomyPolicy, ChannelBriefSchema, type VideoRunState } from "@reelforge/contracts";
import { RunsStore } from "./runs.store.js";
import { json, type Context, type Run, type RunJob } from "./runs.types.js";
import type { RunsQueue } from "./runs.queue.js";
import type { RunsEvents } from "./runs.events.js";

@Injectable()
export class RunsService {
  public queue: RunsQueue | null = null;
  public events: RunsEvents | null = null;
  public constructor(
    public readonly store: RunsStore,
    private readonly artifacts: RunsArtifacts,
  ) {}
  public editor(context: Context): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }
  public async create(context: Context, briefId: string, idempotencyKey: string): Promise<Run> {
    this.editor(context);
    const db = this.store.scoped(context);
    const previous = await db.videoRun.findFirst({ where: { idempotencyKey } });
    if (previous) return this.replay(previous, briefId);
    const briefRow = await db.channelBrief.findFirst({ where: { id: briefId } });
    if (!briefRow) throw new NotFoundException("Brief not found");
    const brief = ChannelBriefSchema.parse(briefRow.document);
    if (
      brief.id !== briefRow.id ||
      brief.workspaceId !== context.workspaceId ||
      brief.version !== briefRow.version ||
      brief.channelId !== briefRow.channelId
    )
      throw new ConflictException("Brief ownership/version mismatch");
    const approvedShorts = await db.runEvent.count({
      where: { type: "approved", run: { channelId: brief.channelId } },
    });
    try {
      return await this.store.db.$transaction(async (tx) => {
        const scoped = this.store.scoped(context, tx);
        const run = await scoped.videoRun.create({
          data: {
            workspaceId: context.workspaceId,
            channelId: brief.channelId,
            channelBriefId: brief.id,
            channelBriefVersion: brief.version,
            requestedAutonomy: brief.requestedAutonomy,
            effectiveAutonomy: autonomyPolicy(brief.requestedAutonomy, approvedShorts).effective,
            approvedShortsAtStart: approvedShorts,
            idempotencyKey,
            correlationId: randomUUID(),
            revision: 1,
            inputSnapshot: json({ brief, actorId: context.userId }),
          },
        });
        await scoped.runEvent.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            sequence: 1,
            type: "created",
            correlationId: run.correlationId,
            payload: { state: "PLANNING" },
          },
        });
        return run;
      });
    } catch (error) {
      const winner = await db.videoRun.findFirst({ where: { idempotencyKey } });
      if (winner) return this.replay(winner, briefId);
      throw error;
    }
  }
  private replay(run: Run, briefId: string): Run {
    if (run.channelBriefId !== briefId)
      throw new ConflictException("Idempotency key reused with different input");
    return run;
  }
  public async enqueue(context: Context, run: Run): Promise<void> {
    await this.queue?.enqueue(
      { workspaceId: context.workspaceId, userId: context.userId, runId: run.id },
      run.revision,
    );
  }
  public async move(
    context: Context,
    run: Run,
    state: VideoRunState,
    reason: string | null = null,
  ): Promise<void> {
    const event = await this.store.transition(context, run.id, run.revision, state, reason);
    await this.events?.publish(event);
  }
  public async detail(context: Context, id: string): Promise<unknown> {
    const run = await this.store.get(context, id),
      db = this.store.scoped(context);
    const [steps, envelope] = await Promise.all([
      db.videoRunStep.findMany({
        where: { runId: id },
        orderBy: [{ key: "asc" }, { attempt: "asc" }],
      }),
      db.budgetEnvelope.findFirst({ where: { runId: id } }),
    ]);
    return {
      run,
      steps,
      envelope,
      artifactUrls: steps.map((step) => ({
        stepId: step.id,
        artifacts: this.artifacts.views(
          context,
          id,
          step.id,
          this.artifacts.descriptors(step.output),
        ),
      })),
    };
  }

  public job(context: Context, runId: string, stepId?: string): RunJob {
    return {
      workspaceId: context.workspaceId,
      userId: context.userId,
      runId,
      ...(stepId ? { stepId } : {}),
    };
  }
}
