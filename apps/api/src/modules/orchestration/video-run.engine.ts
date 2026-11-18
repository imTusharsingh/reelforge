import { createHash } from "node:crypto";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { ConflictException, Injectable, Optional } from "@nestjs/common";
import { createContext, runWithContext, withSpan, metrics } from "@reelforge/observability";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import { z } from "zod";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import {
  RunJobSchema,
  type Context,
  type Run,
  type RunJob,
  type Step,
} from "../runs/runs.types.js";
import { RunGeneration } from "./video-run.generation.js";
import { RunPlanning } from "./video-run.planning.js";
import { RunsControl } from "../runs/runs.control.js";

export function criticPassed(output: unknown): boolean {
  const review = z.object({ result: z.object({ criticPassed: z.boolean() }) }).safeParse(output);
  if (!review.success) throw new ConflictException("Validated critic result is required");
  return review.data.result.criticPassed;
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
    @Optional() private readonly control?: RunsControl,
  ) {}
  /** A return value delays this SAME BullMQ child; it must not release the assembly dependency. */
  public async process(payload: unknown): Promise<number | null> {
    if (!pipelineV2Enabled()) return 12000;
    const job = RunJobSchema.parse(payload);
    const context = await this.context(job);
    const run = await this.runs.store.get(context, job.runId);
    return runWithContext(
      createContext({
        workspaceId: run.workspaceId,
        correlationId: run.correlationId,
        traceparent: `00-${createHash("sha256").update(run.correlationId).digest("hex").slice(0, 32)}-0000000000000001-01`,
      }),
      async () =>
        withSpan(
          `run.step.${job.stepId ? "GENERATING" : run.state}`,
          async () => {
            await this.boundary.check(context, run);
            if (job.stepId) return this.shot(context, run, job.stepId);
            return this.advance(context, run);
          },
          "CONSUMER",
        ),
    );
  }
  private async shot(context: Context, run: Run, stepId: string): Promise<number | null> {
    try {
      return await this.generation.process(context, run, stepId);
    } catch (error) {
      if (error instanceof ConflictException && error.message === "Step already claimed")
        return 12000;
      const current = await this.runs.store.get(context, run.id);
      if (current.state === "GENERATING")
        await this.runs.move(
          context,
          current,
          "PAUSED_BUDGET",
          error instanceof Error ? error.message : "Reconciliation required",
        );
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
      const step = await this.stage(context, run);
      if (!step) return null;
      if (step.state === "WAITING_APPROVAL") return null;
      const current = await this.runs.store.get(context, run.id);
      if (run.state === "CRITIC") {
        if (!criticPassed(step.output)) {
          if (await this.requestRedo(context, run, step.output)) return null;
          await this.runs.move(context, current, "NEEDS_HUMAN", "Critic gate failed");
          return null;
        }
      }
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
  private async stage(context: Context, run: Run): Promise<Step | null> {
    try {
      return await this.planning.stage(context, run);
    } catch (error) {
      if (run.state !== "CRITIC") throw error;
      const current = await this.runs.store.get(context, run.id);
      if (current.state !== "CRITIC") throw error;
      await this.runs.move(
        context,
        current,
        "NEEDS_HUMAN",
        "Critic evidence or provider unavailable",
      );
      return null;
    }
  }
  private async requestRedo(context: Context, run: Run, output: unknown): Promise<boolean> {
    const redo = z
      .object({
        result: z.object({
          redo: z.object({ shots: z.array(z.string().regex(/^\d+$/)), reedit: z.boolean() }),
        }),
      })
      .safeParse(output);
    if (redo.success && this.control) {
      const shot = redo.data.result.redo.shots[0];
      if (shot !== undefined) {
        await this.control.reshoot(context, run.id, Number(shot));
        return true;
      }
      if (redo.data.result.redo.reedit) {
        try {
          await this.control.reedit(context, run.id);
          return true;
        } catch (error) {
          if (
            !(error instanceof ConflictException) ||
            error.message !== "Only one full re-edit per run"
          )
            throw error;
        }
      }
    }
    return false;
  }
  private async generate(context: Context, run: Run): Promise<number | null> {
    const steps = await this.runs.store.scoped(context).videoRunStep.findMany({
      where: {
        runId: run.id,
        key: { startsWith: "shot-" },
        state: { notIn: ["SUCCEEDED", "SKIPPED", "CANCELLED"] },
      },
    });
    if (steps.length) {
      await this.runs.queue?.fanout(
        this.runs.job(context, run.id),
        steps.map((s) => s.id),
        run.revision,
      );
      return null;
    }
    await this.runs.move(context, run, "ASSEMBLING");
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
    if (!pipelineV2Enabled()) return;
    // Enumerate tenant roots only. Every run/step/event/envelope access uses the ADR-003 guard.
    const workspaces = await this.runs.store.db.workspace.findMany({ where: { archivedAt: null } });
    for (const workspace of workspaces) {
      const actor = await this.runs.store.db.workspaceMembership.findFirst({
        where: {
          workspaceId: workspace.id,
          role: { in: ["OWNER", "EDITOR"] },
        },
      });
      if (!actor) continue;
      const context: Context = {
        workspaceId: workspace.id,
        userId: actor.userId,
        role: actor.role,
      };
      await this.artifacts.sweep(context);
      const runs = await this.runs.store.scoped(context).videoRun.findMany({
        where: {
          state: {
            in: ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"],
          },
        },
      });
      for (const run of runs) {
        z.uuid().parse(run.id);
        await this.runs.enqueue(context, run);
      }
    }
  }
}
