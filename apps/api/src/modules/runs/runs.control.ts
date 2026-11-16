import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { RunsService } from "./runs.service.js";
import { RunsBoundary } from "./runs.boundary.js";
import type { Context } from "./runs.types.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";

@Injectable()
export class RunsControl {
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
  ) {}
  public async approve(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state === "AWAITING_APPROVAL") {
      // Scheduling/publishing is V9; record the approval and preserve the locked transition map.
      const result = await this.runs.store.mutate(context, id, "approved", async (db, current) => {
        if (current.state !== "AWAITING_APPROVAL") throw new ConflictException("Already approved");
        await db.videoRun.updateMany({
          where: { id },
          data: { state: "SCHEDULED", pauseReason: null },
        });
        return { value: null, payload: { from: "AWAITING_APPROVAL", to: "SCHEDULED" } };
      });
      await this.runs.events?.publish(result.event);
    } else {
      if (run.effectiveAutonomy !== "L1") throw new ConflictException("No stage approval required");
      const result = await this.runs.store.mutate(context, id, "stage_approved", async (db) => {
        const changed = await db.videoRunStep.updateMany({
          where: { runId: id, key: run.state, state: "WAITING_APPROVAL" },
          data: { state: "SUCCEEDED" },
        });
        if (!changed.count) throw new ConflictException("No stage awaiting approval");
        return { value: null, payload: { stage: run.state } };
      });
      await this.runs.events?.publish(result.event);
      await this.runs.enqueue(context, await this.runs.store.get(context, id));
    }
  }
  public async reedit(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC") throw new ConflictException("Re-edit requires critic boundary");
    const result = await this.runs.store.mutate(context, id, "reedit_requested", async (db) => {
      const key = `${id}:REEDIT:1`;
      if (await db.videoRunStep.findFirst({ where: { runId: id, key: "REEDIT" } }))
        throw new ConflictException("Only one full re-edit per run");
      await db.videoRunStep.create({
        data: {
          workspaceId: context.workspaceId,
          runId: id,
          key: "REEDIT",
          idempotencyKey: key,
          input: {},
        },
      });
      return { value: null, payload: { fullReedits: 1 } };
    });
    await this.runs.events?.publish(result.event);
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async resume(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (!["PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state))
      throw new ConflictException("Run cannot resume");
    await this.runs.move(context, run, "GENERATING");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async reshoot(context: Context, id: string, ordinal: number): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC")
      throw new ConflictException("Reshoots are selected at the critic boundary");
    const db = this.runs.store.scoped(context);
    const previous = await db.videoRunStep.findFirstOrThrow({
      where: { runId: id, key: `shot-${ordinal}` },
      orderBy: { attempt: "desc" },
    });
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: id } });
    if (previous.attempt >= 3 || !envelopeRoom(budget, previous.costMinor ?? 0)) {
      await this.runs.move(context, run, "NEEDS_HUMAN", "Reshoot cap or envelope exhausted");
      return;
    }
    const result = await this.runs.store.mutate(
      context,
      id,
      "reshoot_requested",
      async (scoped) => {
        const shot = ShotSpecSchema.parse(previous.input);
        await scoped.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: id,
            key: previous.key,
            attempt: previous.attempt + 1,
            input: shot,
            idempotencyKey: `${id}:${ordinal}:${previous.attempt + 1}`,
          },
        });
        return { value: null, payload: { ordinal, attempt: previous.attempt + 1 } };
      },
    );
    await this.runs.events?.publish(result.event);
    await this.runs.move(context, await this.runs.store.get(context, id), "GENERATING");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
}
