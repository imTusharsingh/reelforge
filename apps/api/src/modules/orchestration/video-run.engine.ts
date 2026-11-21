import { acceptedAudio } from "../runs/run-audio.js";
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
} from "../runs/runs.types.js";
import { SubmissionOutcomeUnknown } from "../usage-budget/run-paid.js";
import {
  failSettledGeneration,
  storedSubmissionHold,
  unsettledShots,
} from "../runs/run-outcomes.js";
import { AssemblyInterrupted, MissingVideoPricing } from "./video-run.handlers.js";
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
            if (run.state === "FAILED") return null;
            if (job.stepId) return this.shot(context, run, job.stepId);
            if (run.state === "CANCELED")
              return this.planning.collectCanceledAudio?.(context, run) ?? null;
            if (job.assembly && run.state !== "ASSEMBLING") return null;
            if (
              run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
              run.pauseReason === "OPERATOR_ABANDONED"
            )
              return null;
            await this.boundary.check(context, run);
            try {
              return await this.advance(context, run);
            } catch (error) {
              if (error instanceof AssemblyInterrupted) return error.delay;
              if (
                !(error instanceof SubmissionOutcomeUnknown) &&
                error instanceof Error &&
                error.message.startsWith("RECONCILE_REQUIRED")
              )
                await this.hold(context, run, error.message);
              throw error;
            }
          },
          "CONSUMER",
        ),
    );
  }
  private async hold(context: Context, run: Run, reason: string): Promise<void> {
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "reconcile_required",
      async (db, current) => {
        if (
          current.state === run.state &&
          current.pauseReason === null &&
          (await storedSubmissionHold(db, current.id, reason))
        )
          await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: reason } });
        return { value: null, payload: { reason } };
      },
    );
    await this.runs.events?.publish(result.event);
  }
  private async shot(context: Context, run: Run, stepId: string): Promise<number | null> {
    if (run.state === "GENERATING" && !run.pauseReason) await this.boundary.check(context, run);
    try {
      return await this.generation.process(context, run, stepId);
    } catch (error) {
      if (error instanceof ConflictException && error.message === "Step already claimed")
        return 12000;
      if (error instanceof SubmissionOutcomeUnknown) throw error;
      const current = await this.runs.store.get(context, run.id);
      if (error instanceof MissingVideoPricing)
        await this.hold(
          context,
          run,
          `RECONCILE_REQUIRED: missing admission video pricing (${stepId})`,
        );
      else if (error instanceof Error && error.message.startsWith("RECONCILE_REQUIRED"))
        await this.hold(context, run, error.message);
      else if (current.state === "GENERATING" && !current.pauseReason)
        await this.runs.move(context, current, "PAUSED_BUDGET", generationPause(error));
      throw error;
    }
  }
  private async advance(context: Context, run: Run): Promise<number | null> {
    if (run.state === "PLANNING") {
      if (run.effectiveAutonomy === "L1") {
        const step = await this.planning.stage(context, run);
        if (step.state === "WAITING_APPROVAL") return null;
      }
      await this.runs.move(context, await this.runs.store.get(context, run.id), "SCRIPTING");
    } else if (["SCRIPTING", "SHOT_PLANNING", "ASSEMBLING", "CRITIC"].includes(run.state)) {
      if (run.state === "CRITIC") await this.planning.reedit(context, run);
      const step = await this.planning.stage(context, run);
      if (step.state === "WAITING_APPROVAL") return null;
      const current = await this.runs.store.get(context, run.id);
      if (run.state === "SHOT_PLANNING") await this.planning.prepare(context, current);
      const next = {
        SCRIPTING: "SHOT_PLANNING",
        SHOT_PLANNING: "GENERATING",
        ASSEMBLING: "CRITIC",
        CRITIC: "AWAITING_APPROVAL",
      } as const;
      await this.runs.move(
        context,
        await this.runs.store.get(context, run.id),
        next[run.state as keyof typeof next],
      );
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
  public async recover(): Promise<void> {
    // Enumerate tenant roots only. Every run/step/event/envelope access uses the ADR-003 guard.
    const workspaces = await this.runs.store.db.workspace.findMany({ where: { archivedAt: null } });
    for (const workspace of workspaces) {
      const context: Context = {
        workspaceId: workspace.id,
        userId: RECOVERY_PRINCIPAL,
        role: "OWNER",
      };
      await this.artifacts.sweep(context);
      const runs = await this.runs.store.scoped(context).videoRun.findMany({
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
            ],
          },
        },
      });
      for (const run of runs) {
        z.uuid().parse(run.id);
        if (
          run.state === "CANCELED" ||
          run.state === "PAUSED_BUDGET" ||
          run.state === "NEEDS_HUMAN" ||
          run.pauseReason
        ) {
          if (
            run.state === "CANCELED" &&
            (await this.runs.store.scoped(context).videoRunStep.findFirst({
              where: acceptedAudio(run.id),
            }))
          )
            await this.runs.queue?.enqueue(
              { ...this.runs.job(context, run.id), assembly: true },
              run.revision,
            );
          const admitted = await this.runs.store.scoped(context).videoRunStep.findMany({
            where: {
              runId: run.id,
              OR: [{ key: { startsWith: "shot-" } }, { key: { startsWith: "media:keyframe:" } }],
              state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
            },
          });
          for (const step of admitted)
            await this.runs.queue?.enqueue(this.runs.job(context, run.id, step.id), run.revision);
        } else await this.runs.enqueue(context, run);
      }
    }
  }
}
