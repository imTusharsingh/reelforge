import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { RunsService } from "../runs/runs.service.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
import { clipEstimate, fallbackEstimate, runEstimate } from "../usage-budget/run-envelope.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";

@Injectable()
export class RunFallback {
  public constructor(
    private readonly runs: RunsService,
    private readonly paid: RunPaidCalls,
  ) {}
  /** Only a proven pre-dispatch outage can create another paid attempt. Unknown calls reconcile. */
  public async apply(context: Context, run: Run, failed: Step): Promise<void> {
    await this.paid.finish(context, failed, false, 0);
    const result = await this.runs.store.mutate(context, run.id, "fallback", async (db) => {
      const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
      if (budget.route === "FALLBACK") throw new ConflictException("Fallback provider unavailable");
      const all = await db.videoRunStep.findMany({
        where: { runId: run.id, key: { startsWith: "shot-" } },
      });
      const remaining = all.filter((s) => s.state === "PENDING" || s.id === failed.id);
      const initial = all.filter((s) => s.attempt === 1).map((s) => ShotSpecSchema.parse(s.input));
      const overhead = runEstimate(initial).baseEstimateMinor - clipEstimate(initial, false);
      const estimate = fallbackEstimate(
        { ...budget, reservedMinor: budget.reservedMinor - (failed.costMinor ?? 0) },
        remaining.map((s) => ShotSpecSchema.parse(s.input)),
        overhead,
      );
      await db.budgetEnvelope.updateMany({
        where: { id: budget.id },
        data: {
          ...estimate,
          reservedMinor: budget.reservedMinor - (failed.costMinor ?? 0),
          revision: budget.revision + 1,
        },
      });
      await db.videoRunStep.updateMany({
        where: { id: failed.id },
        data: {
          state: "SKIPPED",
          costMinor: 0,
          error: { code: "OUTAGE_NOT_DISPATCHED" },
          finishedAt: new Date(),
        },
      });
      const shot = ShotSpecSchema.parse(failed.input);
      await db.videoRunStep.create({
        data: {
          workspaceId: context.workspaceId,
          runId: run.id,
          key: failed.key,
          attempt: failed.attempt + 1,
          idempotencyKey: `${run.id}:${shot.ordinal}:${failed.attempt + 1}`,
          input: shot,
        },
      });
      return { value: null, payload: { ...estimate, warning: estimate.baseEstimateMinor > 600 } };
    });
    await this.runs.events?.publish(result.event);
  }
}
