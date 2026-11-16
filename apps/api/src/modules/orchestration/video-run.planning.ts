import { RunOutputs } from "./video-run.outputs.js";
import { ConflictException, Injectable } from "@nestjs/common";
import {
  ChannelBriefSchema,
  ShotSpecSchema,
  type ChannelBrief,
  type ShotSpec,
} from "@reelforge/contracts";
import { RunsService } from "../runs/runs.service.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { runEstimate } from "../usage-budget/run-envelope.js";
import { stepHandlers, stubShots, type StepHandler } from "./video-run.handlers.js";

@Injectable()
export class RunPlanning {
  public handlers: Readonly<Record<string, StepHandler>> = stepHandlers;
  public constructor(
    private readonly runs: RunsService,
    private readonly outputs: RunOutputs,
  ) {}
  public brief(run: Run): ChannelBrief {
    const snapshot = json(run.inputSnapshot) as Record<string, unknown>;
    return ChannelBriefSchema.parse(snapshot.brief);
  }
  public async stage(context: Context, run: Run): Promise<Step> {
    const db = this.runs.store.scoped(context);
    const previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: run.state, attempt: 1 },
    });
    if (previous?.state === "SUCCEEDED" || previous?.state === "WAITING_APPROVAL") return previous;
    const handler = this.handlers[run.state];
    if (!handler) throw new ConflictException("Step handler unavailable");
    const step = previous ?? (await this.begin(context, run));
    const output = previous
      ? await handler.reconcile(run, this.brief(run), step)
      : await handler.execute(run, this.brief(run), step);
    if (output === null)
      throw new ConflictException("Stage reconciliation required; no paid resubmission");
    const artifacts = run.state === "ASSEMBLING" ? await this.outputs.assembly(context, run) : [];
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "stage_completed",
      async (scoped, current) => {
        if (current.state !== run.state) throw new ConflictException("Stage changed");
        const waiting =
          run.effectiveAutonomy === "L1" &&
          ["PLANNING", "SCRIPTING", "SHOT_PLANNING"].includes(run.state);
        await scoped.videoRunStep.updateMany({
          where: { id: step.id, runId: run.id },
          data: {
            output: json({ result: output, storageArtifacts: artifacts }),
            state: waiting ? "WAITING_APPROVAL" : "SUCCEEDED",
            finishedAt: new Date(),
          },
        });
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
  private async begin(context: Context, run: Run): Promise<Step> {
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "stage_started",
      async (db, current) => {
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
    const estimate = runEstimate(shots);
    const result = await this.runs.store.mutate(context, run.id, "budget_estimated", async (db) => {
      await db.budgetEnvelope.create({
        data: { workspaceId: context.workspaceId, runId: run.id, ...estimate },
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
          warn: estimate.baseEstimateMinor + estimate.reshootReserveMinor > 600,
        },
      };
    });
    await this.runs.events?.publish(result.event);
  }
  public async reedit(context: Context, run: Run): Promise<void> {
    const db = this.runs.store.scoped(context);
    const step = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: "REEDIT", state: "PENDING" },
    });
    if (!step) return;
    const output = await this.handlers.ASSEMBLING!.execute(run, this.brief(run), step);
    const artifacts = await this.outputs.assembly(context, run);
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "reedit_completed",
      async (scoped) => {
        await scoped.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "SUCCEEDED",
            output: json({ result: output, storageArtifacts: artifacts }),
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
      Math.abs(shots.reduce((sum, s) => sum + s.durationSeconds, 0) - brief.targetDurationSeconds) >
        1
    )
      throw new ConflictException("Invalid shot list");
  }
}
