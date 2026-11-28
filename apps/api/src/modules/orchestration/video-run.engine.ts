import { SessionLockBusy } from "../runs/session-lock.js";
import { isRenderStage, terminalRenderFailure } from "../runs/run-render-stage.js";
import { assemblyFailure } from "../composition/local-assembly-failure.js";
import { recordAssemblyFailure } from "./assembly-recovery.js";
import { pauseRejectedAssembly, savedCaptionRejection } from "./saved-caption-recovery.js";
import { recordShotFailure } from "./video-run.billing-recovery.js";
import { acceptedAudio } from "../runs/run-audio.js";
import { pendingCorrectionWhere } from "../usage-budget/run-pending-receipt.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { ProviderFailure } from "@reelforge/ai-providers";
import { ConflictException, HttpException, Injectable } from "@nestjs/common";
import { createContext, runWithContext, withSpan, metrics } from "@reelforge/observability";
import { z } from "zod";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import {
  RECOVERY_PRINCIPAL,
  RunJobSchema,
  type Context,
  type Run,
  type RunJob,
  type Scoped,
  type Transaction,
} from "../runs/runs.types.js";
import { SubmissionOutcomeUnknown } from "../usage-budget/run-paid.js";
import {
  collectibleFailedSteps,
  referenceMediaPrefix,
  failSettledGeneration,
  activeSubmissionHold,
  unsettledShots,
} from "../runs/run-outcomes.js";
import { AssemblyInterrupted } from "./video-run.handlers.js";
import { MissingVideoPricing } from "../scene-media/media-prices.js";
import { transitionLocked } from "../runs/runs.store.js";
import { InvalidVideoFormat, ShotBillingFailure, ShotMediaFailure } from "./video-run.handlers.js";
import { RunGeneration } from "./video-run.generation.js";
import { RunPlanning } from "./video-run.planning.js";

const pauseCode = z.enum([
  "BUDGET_CAP",
  "BUDGET_EXHAUSTED",
  "BUDGET_POLICY_UNAVAILABLE",
  "BUDGET_CURRENCY_MISMATCH",
  "PROVIDER_REFUSED",
  "PROVIDER_FAILED",
  "PROVIDER_OUTAGE",
  "BUDGET_TIMEZONE_INVALID",
]);
function generationPause(error: unknown): string {
  if (error instanceof ProviderFailure) {
    if (error.kind === "REFUSAL" || error.kind === "NEEDS_HUMAN") return "PROVIDER_REFUSED";
    return `PROVIDER_${error.kind}`;
  }
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === "object" && "code" in response) {
      const parsed = pauseCode.safeParse(response.code);
      if (parsed.success) return parsed.data;
    }
  }
  return "GENERATION_FAILED";
}

@Injectable()
export class VideoRunEngine {
  public readonly queueName = "video-runs-v3";
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
    private readonly generation: RunGeneration,
    private readonly planning: RunPlanning,
    private readonly artifacts: RunsArtifacts,
  ) {}
  /** A return value delays this SAME BullMQ child; it must not release the assembly dependency. */
  public async process(payload: unknown): Promise<number | null> {
    const job = RunJobSchema.parse(payload);
    const context = await this.context(job);
    const run = await this.runs.store.get(context, job.runId);
    if (job.stage && job.stage !== run.state) return null;
    return runWithContext(
      createContext({
        workspaceId: run.workspaceId,
        correlationId: run.correlationId,
        traceparent: job.traceparent,
      }),
      async () =>
        withSpan(
          `run.step.${job.stepId ? "GENERATING" : run.state}`,
          async () => {
            if (run.state === "FAILED") {
              if (!job.stepId) return null;
              const [accepted] = await collectibleFailedSteps(
                this.runs.store.scoped(context),
                this.runs.store.db,
                run,
                job.stepId,
              );
              if (!accepted) return null;
              if (accepted.key.startsWith(referenceMediaPrefix))
                return this.planning.collectAdmittedReference?.(context, accepted) ?? null;
            }
            if (job.stepId) return this.shot(context, run, job.stepId);
            if (!job.assembly && this.runs.queue && run.state === "ASSEMBLING") {
              await this.runs.enqueue(context, run);
              return null;
            }
            if (run.state === "CANCELED" || (isRenderStage(run.state) && run.pauseReason)) {
              if (!job.assembly && this.runs.queue) return null;
              return this.planning.collectAdmittedAudio?.(context, run) ?? null;
            }
            if (job.assembly && run.state !== "ASSEMBLING") return null;
            if (
              ["EMERGENCY_STOP", "OPERATOR_ABANDONED", "CANCEL_REQUESTED"].includes(
                run.pauseReason ?? "",
              ) ||
              run.pauseReason?.startsWith("RECONCILE_REQUIRED")
            )
              return null;
            await this.boundary.check(context, run);
            try {
              return await this.advance(context, run);
            } catch (error) {
              return this.handleStageFailure(context, run, error);
            }
          },
          "CONSUMER",
        ),
    );
  }
  private async handleStageFailure(
    context: Context,
    run: Run,
    error: unknown,
  ): Promise<number | null> {
    if (error instanceof SessionLockBusy) return 12000;
    if (error instanceof AssemblyInterrupted) return error.delay;
    const rejected = isRenderStage(run.state) && savedCaptionRejection(error);
    if (rejected) return pauseRejectedAssembly(this.runs, context, run, rejected);
    const local = isRenderStage(run.state) ? assemblyFailure(error) : undefined;
    if (local) return recordAssemblyFailure(this.runs, context, run, local);
    if (
      !(error instanceof SubmissionOutcomeUnknown) &&
      error instanceof Error &&
      error.message.startsWith("RECONCILE_REQUIRED")
    )
      return this.handleFailure(context, run, error);
    throw error;
  }
  private async holdLocked(
    db: Scoped,
    tx: Transaction,
    run: Run,
    current: Run,
    reason: string,
  ): Promise<void> {
    const halted = ["EMERGENCY_STOP", "CANCEL_REQUESTED"].includes(current.pauseReason ?? "");
    if (current.state === run.state && !halted) {
      const pauseReason = current.pauseReason?.startsWith("RECONCILE_REQUIRED")
        ? current.pauseReason
        : reason;
      const hold = await activeSubmissionHold(db, tx, { ...current, pauseReason });
      if (hold && current.pauseReason !== hold && !(await terminalRenderFailure(db, current)))
        await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: hold } });
    }
  }
  private async shot(context: Context, run: Run, stepId: string): Promise<number | null> {
    if (run.state === "GENERATING" && !run.pauseReason) await this.boundary.check(context, run);
    try {
      return await this.generation.process(context, run, stepId);
    } catch (error) {
      if (error instanceof ConflictException && error.message === "Step already claimed")
        return 12000;
      if (error instanceof SubmissionOutcomeUnknown) throw error;
      return this.handleFailure(context, run, error, stepId);
    }
  }
  private async handleFailure(
    context: Context,
    run: Run,
    error: unknown,
    stepId?: string,
  ): Promise<null> {
    const cause =
      error instanceof ShotBillingFailure ||
      (error instanceof ShotMediaFailure && !(error instanceof InvalidVideoFormat))
        ? error.cause
        : error;
    const hold =
      cause instanceof MissingVideoPricing && stepId
        ? MissingVideoPricing.hold(stepId)
        : cause instanceof Error && cause.message.startsWith("RECONCILE_REQUIRED")
          ? cause.message
          : null;
    const result = await this.runs.store.mutate(
      context,
      run.id,
      hold ? "reconcile_required" : "transition",
      async (db, current, tx) => {
        if (stepId) {
          const result = await recordShotFailure(
            db,
            current,
            stepId,
            error,
            cause,
            generationPause(cause),
          );
          if (result) return result;
        }
        if (hold) {
          await this.holdLocked(db, tx, run, current, hold);
          return { value: null, payload: { reason: hold } };
        }
        if (current.state !== "GENERATING" || current.pauseReason) throw cause;
        return transitionLocked(db, current, "PAUSED_BUDGET", generationPause(cause));
      },
    );
    await this.runs.events?.publish(result.event);
    if (result.event.type === "redundant_clip_discarded") return null;
    throw cause;
  }
  private async advance(context: Context, run: Run): Promise<number | null> {
    if (run.state === "PLANNING") {
      if (run.effectiveAutonomy === "L1") {
        const step = await this.planning.stage(context, run);
        if (step.state === "WAITING_APPROVAL") return null;
      }
      if (!(await this.runs.move(context, await this.runs.store.get(context, run.id), "SCRIPTING")))
        return 12000;
    } else if (["SCRIPTING", "SHOT_PLANNING", "ASSEMBLING", "CRITIC"].includes(run.state)) {
      const step = await this.planning.stage(context, run);
      if (step.state === "WAITING_APPROVAL") return null;
      const current = await this.runs.store.get(context, run.id);
      if (isRenderStage(run.state) && (current.state !== run.state || current.pauseReason))
        return null;
      if (run.state === "SHOT_PLANNING") await this.planning.prepare(context, current);
      const next = {
        SCRIPTING: "SHOT_PLANNING",
        SHOT_PLANNING: "GENERATING",
        ASSEMBLING: "CRITIC",
        CRITIC: "AWAITING_APPROVAL",
      } as const;
      if (
        !(await this.runs.move(
          context,
          run.state === "SHOT_PLANNING" ? await this.runs.store.get(context, run.id) : current,
          next[run.state as keyof typeof next],
        ))
      )
        return 12000;
    } else if (run.state === "GENERATING") return this.generate(context, run);
    else return null;
    await this.runs.enqueue(context, await this.runs.store.get(context, run.id));
    return null;
  }
  private async generate(context: Context, run: Run): Promise<number | null> {
    const steps = await this.runs.store.scoped(context).videoRunStep.findMany({
      where: unsettledShots(run.id),
    });
    const current = await this.runs.store.get(context, run.id);
    if (current.state !== "GENERATING" || current.pauseReason) return null;
    if (current.revision !== run.revision) {
      await this.runs.enqueue(context, current);
      return null;
    }
    if (steps.length) {
      await this.runs.queue?.fanout(
        this.runs.job(context, run.id),
        steps.map((s) => s.id),
        run.revision,
      );
      return null;
    }
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "transition",
      async (db, locked) => {
        if (locked.revision !== run.revision || locked.state !== "GENERATING" || locked.pauseReason)
          return { value: false, payload: { stale: true } };
        if (await failSettledGeneration(db, locked))
          return { value: false, payload: { from: locked.state, to: "FAILED" } };
        await db.videoRun.updateMany({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
        return { value: true, payload: { from: locked.state, to: "ASSEMBLING" } };
      },
    );
    await this.runs.events?.publish(result.event);
    if (!result.value) {
      const latest = await this.runs.store.get(context, run.id);
      if (latest.state === "GENERATING") await this.runs.enqueue(context, latest);
      return null;
    }
    const envelope = await this.runs.store
      .scoped(context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    metrics
      .histogram("run_cost_minor", "Completed generation cost per run")
      .observe({}, envelope.spentMinor);
    await this.runs.enqueue(context, await this.runs.store.get(context, run.id));
    return null;
  }
  private async context(job: RunJob): Promise<Context> {
    if (job.userId === RECOVERY_PRINCIPAL) {
      const active = await this.runs.store.db.workspace.findFirst({
        where: { id: job.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!active) throw new ConflictException("Recovered run workspace is inactive");
      return { workspaceId: active.id, userId: RECOVERY_PRINCIPAL, role: "OWNER" };
    }
    const membership = await this.runs.store.db.workspaceMembership.findFirst({
      where: {
        workspaceId: job.workspaceId,
        userId: job.userId,
        workspace: { archivedAt: null },
      },
    });
    if (!membership || membership.role === "VIEWER")
      throw new ConflictException("Worker actor no longer authorized");
    return { workspaceId: job.workspaceId, userId: job.userId, role: membership.role };
  }
  private async enqueuePendingCorrections(context: Context, db: Scoped): Promise<void> {
    const corrections = await db.videoRunStep.findMany({
      where: { ...pendingCorrectionWhere, run: { state: { not: "FAILED" } } },
      select: { id: true, runId: true },
    });
    for (const step of corrections) {
      const run = await db.videoRun.findFirstOrThrow({
        where: { id: step.runId },
        select: { revision: true },
      });
      await this.runs.queue?.enqueue(this.runs.job(context, step.runId, step.id), run.revision);
    }
  }
  public async recover(): Promise<void> {
    // Enumerate tenant roots only. Every run/step/event/envelope access uses the ADR-003 guard.
    const workspaces = await this.runs.store.listRecoveryWorkspaces();
    for (const workspace of workspaces) {
      const context: Context = {
        workspaceId: workspace.id,
        userId: RECOVERY_PRINCIPAL,
        role: "OWNER",
      };
      await this.planning.recoverText(context);
      await this.artifacts.sweep(context);
      const db = this.runs.store.scoped(context);
      await this.enqueuePendingCorrections(context, db);
      const runs = await db.videoRun.findMany({
        where: {
          state: {
            in: [
              "PLANNING",
              "SCRIPTING",
              "SHOT_PLANNING",
              "GENERATING",
              "ASSEMBLING",
              "CRITIC",
              "PAUSED_BUDGET",
              "NEEDS_HUMAN",
              "CANCELED",
              "FAILED",
            ],
          },
        },
      });
      for (const run of runs) {
        z.uuid().parse(run.id);
        if (
          run.state === "CANCELED" ||
          run.state === "FAILED" ||
          run.state === "PAUSED_BUDGET" ||
          run.state === "NEEDS_HUMAN" ||
          run.pauseReason
        ) {
          await this.enqueueAdmitted(context, db, run);
        } else await this.runs.enqueue(context, run);
      }
    }
  }
  private async enqueueAdmitted(context: Context, db: Scoped, run: Run): Promise<void> {
    if (
      (run.state === "CANCELED" || isRenderStage(run.state)) &&
      (await acceptedAudio(db, this.runs.store.db, run)).length
    )
      await this.runs.queue?.enqueue(
        { ...this.runs.job(context, run.id), assembly: true },
        run.revision,
      );
    const admitted =
      run.state === "FAILED"
        ? await collectibleFailedSteps(db, this.runs.store.db, run)
        : await db.videoRunStep.findMany({
            where: {
              runId: run.id,
              OR: [{ key: { startsWith: "shot-" } }, { key: { startsWith: "media:keyframe:" } }],
              state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
            },
          });
    for (const step of admitted)
      await this.runs.queue?.enqueue(this.runs.job(context, run.id, step.id), run.revision);
  }
}
