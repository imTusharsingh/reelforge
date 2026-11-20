import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { foundationWorkspaceGuard } from "@reelforge/database";
import { VIDEO_RUN_TRANSITIONS, type VideoRunState } from "@reelforge/contracts";
import { scopedTransaction } from "./runs.transaction.js";
import type { Context, Database, Event, Json, Run, Scoped, Transaction } from "./runs.types.js";

@Injectable()
export class RunsStore {
  public constructor(@Inject("DATABASE") public readonly db: Database) {}
  public scoped(context: Context, tx?: Transaction): Scoped {
    return tx ? scopedTransaction(tx, context) : foundationWorkspaceGuard(this.db, context);
  }
  public async get(context: Context, id: string): Promise<Run> {
    const run = await this.scoped(context).videoRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }
  /** A run revision serializes ALL event/step/envelope mutations. Events commit with their state. */
  public async mutate<T>(
    context: Context,
    id: string,
    type: string,
    work: (
      db: Scoped,
      run: Run,
      tx: Transaction,
    ) => Promise<{ value: T; payload: Json; stepId?: string; eventType?: string }>,
  ): Promise<{ value: T; event: Event }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.mutateOnce(context, id, type, work);
      } catch (error) {
        if (
          attempt >= 7 ||
          !(error instanceof ConflictException) ||
          error.message !== "Run revision conflict"
        )
          throw error;
      }
    }
  }
  private async mutateOnce<T>(
    context: Context,
    id: string,
    type: string,
    work: (
      db: Scoped,
      run: Run,
      tx: Transaction,
    ) => Promise<{ value: T; payload: Json; stepId?: string; eventType?: string }>,
  ): Promise<{ value: T; event: Event }> {
    return this.db.$transaction(async (tx) => {
      const db = this.scoped(context, tx);
      const run = await db.videoRun.findFirst({ where: { id } });
      if (!run) throw new NotFoundException("Run not found");
      const updated = await db.videoRun.updateMany({
        where: { id, revision: run.revision },
        data: { revision: run.revision + 1 },
      });
      if (updated.count !== 1) throw new ConflictException("Run revision conflict");
      const result = await work(db, run, tx);
      const event = await db.runEvent.create({
        data: {
          workspaceId: context.workspaceId,
          runId: id,
          sequence: run.revision + 1,
          type: result.eventType ?? type,
          correlationId: run.correlationId,
          payload: result.payload,
          stepId: result.stepId ?? null,
        },
      });
      return { value: result.value, event };
    });
  }
  public async transition(
    context: Context,
    id: string,
    expectedRevision: number,
    state: VideoRunState,
    reason: string | null = null,
  ): Promise<Event> {
    const result = await this.mutate(context, id, "transition", async (db, run) => {
      if (run.revision !== expectedRevision || !VIDEO_RUN_TRANSITIONS[run.state].includes(state))
        throw new ConflictException("Illegal or stale run transition");
      await db.videoRun.updateMany({
        where: { id },
        data: {
          state,
          pauseReason: reason,
          ...(run.effectiveAutonomy === "L3" &&
          ["PAUSED_BUDGET", "NEEDS_HUMAN", "FAILED"].includes(state)
            ? { effectiveAutonomy: "L2" }
            : {}),
        },
      });
      return { value: null, payload: { from: run.state, to: state, reason } };
    });
    return result.event;
  }
  public async events(context: Context, id: string, after: number): Promise<Event[]> {
    await this.get(context, id);
    return this.scoped(context).runEvent.findMany({
      where: { runId: id, sequence: { gt: after } },
      orderBy: { sequence: "asc" },
      take: 500,
    });
  }
}
