import { canOwnerConfirmText } from "../usage-budget/text-attempt-owner.js";
import { completedStages } from "./completed-stages.js";
import { claimedRunCost, pinnedBudget } from "../usage-budget/run-envelope.js";
import { canAdvancePastRender } from "./run-render-stage.js";
import { MAX_SHOT_RESHOOTS, shotReshoots } from "./shot-reshoots.js";
import { currentContext, formatTraceparent, parseTraceparent } from "@reelforge/observability";
import { countApprovedShorts } from "../channel/brief-approvals.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import { assertVideoRunLanguage, assertVideoRunPace } from "../composition/video-run-language.js";
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { autonomyPolicy, StoredChannelBriefSchema, type VideoRunState } from "@reelforge/contracts";
import { activeSubmissionHold, clearResolvedSubmissionHold } from "./run-outcomes.js";
import { RunsStore, transitionLocked } from "./runs.store.js";
import { json, type Context, type Run, type RunJob, type Step, type Json } from "./runs.types.js";
import type { RunQueueHealth, RunsQueue } from "./runs.queue.js";
import type { RunsEvents } from "./runs.events.js";

@Injectable()
export class RunsService {
  public async queueHealth(): Promise<RunQueueHealth> {
    return this.queue?.health() ?? "NOT_CONFIGURED";
  }

  public queue: RunsQueue | null = null;
  public events: RunsEvents | null = null;
  public constructor(
    public readonly store: RunsStore,
    public readonly artifacts: RunsArtifacts,
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
    const brief = StoredChannelBriefSchema.parse(briefRow.document);
    if (
      brief.id !== briefRow.id ||
      brief.workspaceId !== context.workspaceId ||
      brief.version !== briefRow.version ||
      brief.channelId !== briefRow.channelId
    )
      throw new ConflictException("Brief ownership/version mismatch");
    assertVideoRunPace(brief.narratorVoice?.pace);
    assertVideoRunLanguage(() => brief.languages.narration);
    const approvedShorts = await countApprovedShorts(db, brief.channelId);
    const requestContext = currentContext();
    const traceparent = requestContext && formatTraceparent(requestContext);
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
            inputSnapshot: json({
              brief,
              actorId: context.userId,
              ...(traceparent ? { traceparent } : {}),
            }),
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
  public async attachJob(
    context: Context,
    step: Step,
    providerJobId: string,
    output?: Json,
  ): Promise<Step> {
    const saved = await this.store.mutate(
      context,
      step.runId,
      "provider_submitted",
      async (db, currentRun, tx) => {
        if (step.key.startsWith("media:text:"))
          throw new ConflictException("Text receipts must be ingested into the evidence journal");
        const changed = await db.videoRunStep.updateMany({
          where: {
            id: step.id,
            runId: step.runId,
            state: "RUNNING",
            idempotencyKey: step.idempotencyKey,
            providerJobId: null,
          },
          data: {
            providerJobId,
            state: "WAITING_EXTERNAL",
            ...(output !== undefined ? { output } : {}),
          },
        });
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (!changed.count && current.providerJobId !== providerJobId)
          throw new ConflictException("Provider job claim changed");
        await clearResolvedSubmissionHold(db, tx, currentRun, step.id);
        return {
          value: current,
          payload: { providerJobId, idempotencyKey: step.idempotencyKey },
          stepId: step.id,
        };
      },
    );
    await this.events?.publish(saved.event);
    return saved.value;
  }
  public async enqueue(context: Context, run: Run): Promise<void> {
    if (
      run.state === "CANCELED" ||
      run.pauseReason === "EMERGENCY_STOP" ||
      run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
      run.pauseReason === "OPERATOR_ABANDONED" ||
      run.pauseReason === "CANCEL_REQUESTED"
    )
      return;
    const job = this.job(context, run.id);
    if (run.state === "ASSEMBLING") job.assembly = true;
    const snapshot = run.inputSnapshot;
    if (
      !job.traceparent &&
      snapshot &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot) &&
      typeof snapshot.traceparent === "string" &&
      parseTraceparent(snapshot.traceparent)
    )
      job.traceparent = snapshot.traceparent;
    if (
      run.state === "PLANNING" ||
      run.state === "SCRIPTING" ||
      run.state === "SHOT_PLANNING" ||
      run.state === "CRITIC"
    )
      job.stage = run.state;
    await this.queue?.enqueue(job, run.revision);
  }
  public async move(
    context: Context,
    run: Run,
    state: VideoRunState,
    reason: string | null = null,
  ): Promise<boolean> {
    const result = await this.store.mutate(
      context,
      run.id,
      "transition",
      async (db, current, tx) => {
        const renderAdvanceAllowed = await canAdvancePastRender(db, current, state);
        const advances =
          state === "SCRIPTING" ||
          state === "SHOT_PLANNING" ||
          state === "GENERATING" ||
          state === "ASSEMBLING" ||
          state === "CRITIC" ||
          state === "AWAITING_APPROVAL";
        // A pending correction still needs a durable hold even if rendering has not completed.
        // But never replace an existing render pause while discarding stale advancement.
        const hold =
          advances && current.pauseReason?.startsWith("RECONCILE_REQUIRED")
            ? current.pauseReason
            : advances && (renderAdvanceAllowed || !current.pauseReason)
              ? await activeSubmissionHold(db, tx, current)
              : null;
        if (hold) {
          if (
            current.pauseReason !== "EMERGENCY_STOP" &&
            !current.pauseReason?.startsWith("RECONCILE_REQUIRED")
          )
            await db.videoRun.updateMany({
              where: { id: current.id },
              data: { pauseReason: hold },
            });
          return {
            value: false,
            payload: { reason: hold },
            eventType: "reconcile_required",
          };
        }
        if (!renderAdvanceAllowed)
          return { value: false, payload: { stale: true }, eventType: "stage_advance_discarded" };
        await transitionLocked(db, current, state, reason, run.revision);
        return { value: true, payload: { from: current.state, to: state, reason } };
      },
    );
    await this.events?.publish(result.event);
    return result.value;
  }
  public async detail(context: Context, id: string): Promise<unknown> {
    await this.artifacts.refreshManifests(context, id);
    const run = await this.store.get(context, id),
      db = this.store.scoped(context);
    const [steps, envelope, requests, completed] = await Promise.all([
      db.videoRunStep.findMany({
        where: { runId: id },
        orderBy: [{ key: "asc" }, { attempt: "asc" }],
      }),
      db.budgetEnvelope.findFirst({ where: { runId: id } }),
      shotReshoots(db, id),
      completedStages(db, id, run.revision),
    ]);
    const cap = pinnedBudget(run).hardCapMinor;
    return {
      run,
      steps: await this.stepViews(context, run, steps),
      envelope,
      pinnedHardCapMinor: cap,
      remainingBudgetMinor: Math.max(0, cap - claimedRunCost(steps)),
      completedStages: completed,
      remainingReshoots: Object.fromEntries(
        [...new Set(steps.map((step) => step.key))]
          .filter((key) => key.startsWith("shot-"))
          .map((key) => [
            key,
            Math.max(0, MAX_SHOT_RESHOOTS - requests.filter((r) => r.key === key).length),
          ]),
      ),
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

  private async stepViews(
    context: Context,
    run: Run,
    steps: Step[],
  ): Promise<(Step & { confirmTerminalText: boolean; awaitingReconciliation: boolean })[]> {
    return Promise.all(
      steps.map(async (step) => {
        const held =
          !!run.pauseReason?.startsWith("RECONCILE_REQUIRED") && step.state === "RUNNING";
        const named = !!run.pauseReason?.includes(step.id);
        const candidate =
          step.key.startsWith("media:text:") &&
          ((held && named) || (run.state === "FAILED" && step.state === "FAILED"));
        return {
          ...step,
          confirmTerminalText:
            candidate && (await canOwnerConfirmText(this.store.db, step, context, this.artifacts)),
          awaitingReconciliation:
            held && (named || step.key === run.state || step.key === "planning:manifest:v1"),
        };
      }),
    );
  }
  public job(context: Context, runId: string, stepId?: string): RunJob {
    const active = currentContext();
    return {
      ...(active ? { traceparent: formatTraceparent(active) } : {}),
      workspaceId: context.workspaceId,
      userId: context.userId,
      runId,
      ...(stepId ? { stepId } : {}),
    };
  }
}
