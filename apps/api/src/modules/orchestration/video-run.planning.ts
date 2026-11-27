import { isRenderStage, pendingRenderEdit } from "../runs/run-render-stage.js";
import { Prisma } from "@reelforge/database";
import { fitsAssemblyDuration } from "../script/planning-validation.js";
import { settledMediaSpend } from "../usage-budget/run-media-spend.js";
import { assemblyStageOutput } from "../composition/assembly-receipts.js";
import { RunOutputs } from "./video-run.outputs.js";
import { ConflictException, Injectable } from "@nestjs/common";
import {
  StoredChannelBriefSchema,
  ShotSpecSchema,
  type ChannelBrief,
  type ShotSpec,
} from "@reelforge/contracts";
import { RunsService } from "../runs/runs.service.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { pinnedBudget, runEstimate } from "../usage-budget/run-envelope.js";
import {
  AssemblyInterrupted,
  stepHandlers,
  stubShots,
  type StepHandler,
} from "./video-run.handlers.js";

@Injectable()
export class RunPlanning {
  public collectAdmittedReference?: (context: Context, step: Step) => Promise<number | null>;
  public collectAdmittedAudio?: (context: Context, run: Run) => Promise<number | null>;
  public handlers: Readonly<Record<string, StepHandler>> = stepHandlers;
  public constructor(
    private readonly runs: RunsService,
    private readonly outputs: RunOutputs,
  ) {}
  public brief(run: Run): ChannelBrief {
    const snapshot = json(run.inputSnapshot) as Record<string, unknown>;
    return StoredChannelBriefSchema.parse(snapshot.brief);
  }
  public async stage(context: Context, run: Run): Promise<Step> {
    const db = this.runs.store.scoped(context);
    let previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: run.state, attempt: 1 },
    });
    if (
      run.state === "CRITIC" &&
      previous?.state === "SUCCEEDED" &&
      (await pendingRenderEdit(db, run.id))
    )
      previous = await this.reopenCritic(context, run, previous);
    if (previous?.state === "SUCCEEDED" || previous?.state === "WAITING_APPROVAL") return previous;
    const handler = this.handlers[run.state];
    if (!handler) throw new ConflictException("Step handler unavailable");
    const step = previous ?? (await this.begin(context, run));
    if (run.state === "CRITIC") await this.reedit(context, run);
    const output = previous
      ? await handler.reconcile(run, this.brief(run), step, context)
      : await handler.execute(run, this.brief(run), step, context);
    if (output === null)
      throw new ConflictException("Stage reconciliation required; no paid resubmission");
    const artifacts = run.state === "ASSEMBLING" ? await this.outputs.assembly(context, run) : [];
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "stage_completed",
      async (scoped, current) => {
        const renderStage = isRenderStage(run.state);
        if (renderStage && (current.state !== run.state || current.pauseReason))
          throw new AssemblyInterrupted(null);
        if (current.state !== run.state) throw new ConflictException("Stage changed");
        const waiting =
          run.effectiveAutonomy === "L1" &&
          ["PLANNING", "SCRIPTING", "SHOT_PLANNING"].includes(run.state);
        const changed = await scoped.videoRunStep.updateMany({
          where: { id: step.id, runId: run.id, ...(renderStage ? { state: "RUNNING" } : {}) },
          data: {
            output:
              run.state === "ASSEMBLING"
                ? await assemblyStageOutput(scoped, run.id, output, artifacts)
                : json({ result: output, storageArtifacts: artifacts }),
            state: waiting ? "WAITING_APPROVAL" : "SUCCEEDED",
            ...(renderStage ? { error: Prisma.DbNull } : {}),
            finishedAt: new Date(),
          },
        });
        if (renderStage && changed.count !== 1) throw new AssemblyInterrupted(null);
        const saved = await scoped.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        return {
          value: saved,
          payload: { stage: run.state, waitingApproval: waiting },
          stepId: step.id,
        };
      },
    );
    await this.runs.events?.publish(result.event);
    return result.value;
  }
  private async reopenCritic(context: Context, run: Run, step: Step): Promise<Step> {
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "critic_reopened",
      async (db, current) => {
        if (current.state !== "CRITIC" || current.pauseReason) throw new AssemblyInterrupted(null);
        if (await pendingRenderEdit(db, run.id))
          await db.videoRunStep.updateMany({
            where: { id: step.id, state: "SUCCEEDED" },
            data: { state: "RUNNING", finishedAt: null },
          });
        const value = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        return { value, payload: {}, stepId: step.id };
      },
    );
    await this.runs.events?.publish(result.event);
    return result.value;
  }
  private async begin(context: Context, run: Run): Promise<Step> {
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "stage_started",
      async (db, current) => {
        if (isRenderStage(run.state) && current.pauseReason) throw new AssemblyInterrupted(null);
        if (current.state !== run.state) throw new ConflictException("Stage changed");
        const key = `${run.id}:${run.state}:1`;
        const existing = await db.videoRunStep.findFirst({
          where: { runId: run.id, key: run.state },
        });
        if (existing) throw new ConflictException("Stage already claimed");
        const step = await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key: run.state,
            idempotencyKey: key,
            state: "RUNNING",
            startedAt: new Date(),
            input: {},
          },
        });
        return { value: step, payload: { stage: run.state }, stepId: step.id };
      },
    );
    await this.runs.events?.publish(result.event);
    return result.value;
  }
  public async prepare(context: Context, run: Run): Promise<void> {
    const scoped = this.runs.store.scoped(context);
    if (await scoped.budgetEnvelope.findFirst({ where: { runId: run.id } })) return;
    // V4 owns shot-spec writes. V3 reads their records, or persists stub shots in its own step inputs.
    const records = await scoped.shotSpec.findMany({
      where: { runId: run.id },
      orderBy: { ordinal: "asc" },
    });
    const shots = records.length
      ? records.map((row) => ShotSpecSchema.parse(row.document))
      : stubShots(run, this.brief(run));
    this.validateShots(run, shots);
    const { targetMinor, hardCapMinor } = pinnedBudget(run);
    const result = await this.runs.store.mutate(context, run.id, "budget_estimated", async (db) => {
      if (await db.budgetEnvelope.findFirst({ where: { runId: run.id } }))
        return { value: null, payload: json({ replay: true }) };
      const planningSpentMinor = await settledMediaSpend(db, run.id, true);
      const estimate = runEstimate(shots, false, hardCapMinor, planningSpentMinor);
      await db.budgetEnvelope.create({
        data: {
          workspaceId: context.workspaceId,
          runId: run.id,
          targetMinor,
          hardCapMinor,
          baseEstimateMinor: estimate.baseEstimateMinor,
          reshootReserveMinor: estimate.reshootReserveMinor,
          spentMinor: planningSpentMinor,
          route: estimate.route,
        },
      });
      for (const shot of shots)
        await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key: `shot-${shot.ordinal}`,
            attempt: 1,
            idempotencyKey: `${run.id}:${shot.ordinal}:1`,
            input: json(shot),
          },
        });
      return {
        value: null,
        payload: {
          ...estimate,
          warn: estimate.baseEstimateMinor + estimate.reshootReserveMinor > targetMinor,
        },
      };
    });
    await this.runs.events?.publish(result.event);
  }
  private async reedit(context: Context, run: Run): Promise<void> {
    const db = this.runs.store.scoped(context);
    const step = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: "REEDIT", state: "PENDING" },
    });
    if (!step) return;
    const output = await this.handlers.ASSEMBLING!.execute(run, this.brief(run), step, context);
    const artifacts = await this.outputs.assembly(context, run);
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "reedit_completed",
      async (scoped, current) => {
        if (current.state !== run.state || current.pauseReason) throw new AssemblyInterrupted(null);
        await scoped.videoRunStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data: {
            state: "SUCCEEDED",
            output: await assemblyStageOutput(scoped, run.id, output, artifacts),
            finishedAt: new Date(),
          },
        });
        return { value: null, payload: { stub: true }, stepId: step.id };
      },
    );
    await this.runs.events?.publish(result.event);
  }
  private validateShots(run: Run, shots: ShotSpec[]): void {
    const brief = this.brief(run);
    if (
      !shots.length ||
      new Set(shots.map((s) => s.ordinal)).size !== shots.length ||
      shots.some((s) => s.runId !== run.id || s.workspaceId !== run.workspaceId) ||
      !fitsAssemblyDuration(shots, brief.targetDurationSeconds)
    )
      throw new ConflictException("Invalid shot list");
  }
}
