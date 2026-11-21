import { completedRedos, shotReshoots } from "../runs/shot-reshoots.js";
import { ConflictException } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { RunCriticReportSchema, type ChannelBrief } from "@reelforge/contracts";
import type { StepHandler } from "../orchestration/video-run.handlers.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { MediaAssembly } from "../composition/media-assembly.js";
import { RunsControl } from "../runs/runs.control.js";
import { RunsService } from "../runs/runs.service.js";
import { json, type Context, type Json, type Run, type Step } from "../runs/runs.types.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";
import { criticReservationCents } from "./critic-text-port.js";
import type { RunCritic } from "./run-critic.js";

export class CriticStep implements StepHandler {
  public constructor(
    private readonly modules: ModuleRef,
    private readonly critic: () => RunCritic,
  ) {}

  public onModuleInit(): void {
    const planning = this.modules.get(RunPlanning, { strict: false });
    planning.handlers = { ...planning.handlers, CRITIC: this };
  }

  public async execute(run: Run, brief: ChannelBrief, step: Step, context: Context): Promise<Json> {
    const runs = this.modules.get(RunsService, { strict: false });
    const db = runs.store.scoped(context);
    const attempts = await db.videoRunStep.findMany({
      where: {
        runId: run.id,
        OR: [{ key: "REEDIT" }, { key: { startsWith: "shot-" }, attempt: { gt: 1 } }],
      },
      orderBy: { attempt: "desc" },
    });
    // A reshoot enters GENERATING through V3. Its next CRITIC visit reconciles this same step.
    const requests = await shotReshoots(db, run.id);
    const completed = completedRedos(attempts, requests);
    if (completed.length) await this.refreshAssembly(runs, context, run, brief, completed);
    const result = await this.critic().execute(context, run, brief, step, 1 + completed.length);
    await this.redo(context, run, db, attempts, requests, result.redo);
    const report = RunCriticReportSchema.parse(result.report);
    await this.savePackaging(runs, context, run, result);
    return json(report);
  }

  public reconcile(run: Run, brief: ChannelBrief, step: Step, context: Context): Promise<Json> {
    // RunCritic replays completed paid calls and blocks redispatch for unresolved intents.
    return this.execute(run, brief, step, context);
  }

  private async savePackaging(
    runs: RunsService,
    context: Context,
    run: Run,
    result: Awaited<ReturnType<RunCritic["execute"]>>,
  ): Promise<void> {
    const key = "quality:packaging";
    const saved = await runs.store.mutate(
      context,
      run.id,
      "critic_packaged",
      async (db, current) => {
        if (current.state !== "CRITIC") throw new ConflictException("Critic stage changed");
        const output = json({ result });
        const previous = await db.videoRunStep.findFirst({ where: { runId: run.id, key } });
        const data = { output, finishedAt: new Date() };
        if (previous) {
          await db.videoRunStep.updateMany({ where: { id: previous.id }, data });
          return { value: null, payload: {}, stepId: previous.id };
        }
        const created = await db.videoRunStep.create({
          data: {
            ...data,
            workspaceId: context.workspaceId,
            runId: run.id,
            key,
            idempotencyKey: `${run.id}:${key}:1`,
            state: "SUCCEEDED",
            input: {},
          },
        });
        return { value: null, payload: {}, stepId: created.id };
      },
    );
    await runs.events?.publish(saved.event);
  }

  private async redo(
    context: Context,
    run: Run,
    db: ReturnType<RunsService["store"]["scoped"]>,
    attempts: Step[],
    requests: Awaited<ReturnType<typeof shotReshoots>>,
    redo: { shots: string[]; reedit: boolean },
  ): Promise<void> {
    if (!redo.shots.length && !redo.reedit) return;
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    const control = this.modules.get(RunsControl, { strict: false });
    for (const shot of redo.shots) {
      const ordinal = Number(shot);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) continue;
      const key = `shot-${ordinal}`;
      const previous =
        attempts.find((item) => item.key === key) ??
        (await db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key, attempt: 1 } }));
      if (
        requests.filter((request) => request.key === key).length >= 2 ||
        !envelopeRoom(budget, (previous.costMinor ?? 0) + criticReservationCents())
      )
        continue;
      await control.reshoot(context, run.id, ordinal);
      throw new ConflictException("Critic deferred while V3 processes the reshoot");
    }
    if (
      redo.reedit &&
      !attempts.some((item) => item.key === "REEDIT") &&
      envelopeRoom(budget, criticReservationCents())
    ) {
      await control.reedit(context, run.id);
      throw new ConflictException("Critic deferred while V3 processes the re-edit");
    }
  }

  private async refreshAssembly(
    runs: RunsService,
    context: Context,
    run: Run,
    brief: ChannelBrief,
    completed: Step[],
  ): Promise<void> {
    const db = runs.store.scoped(context);
    const cached = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: "local:assembly" },
    });
    const latestChange = Math.max(
      ...completed.map((item) =>
        (item.key === "REEDIT" ? item.createdAt : (item.finishedAt ?? item.createdAt)).getTime(),
      ),
    );
    if (cached && cached.createdAt.getTime() < latestChange) {
      const archived = await runs.store.mutate(
        context,
        run.id,
        "critic_assembly_invalidated",
        async (scoped, current) => {
          if (current.state !== "CRITIC") throw new ConflictException("Critic stage changed");
          await scoped.videoRunStep.updateMany({
            where: { id: cached.id, key: "local:assembly" },
            data: {
              key: `quality:assembly-history:${cached.id}`,
              idempotencyKey: `${cached.idempotencyKey}:${cached.id}`,
            },
          });
          return { value: null, payload: {}, stepId: cached.id };
        },
      );
      await runs.events?.publish(archived.event);
    }
    const assembly = this.modules.get(MediaAssembly, { strict: false });
    const artifacts = await assembly.execute(context, run, brief);
    await db.videoRunStep.updateMany({
      where: { runId: run.id, key: { in: ["ASSEMBLING", "REEDIT"] }, state: "SUCCEEDED" },
      data: {
        output: json({ result: { storageArtifacts: artifacts }, storageArtifacts: artifacts }),
      },
    });
  }
}
