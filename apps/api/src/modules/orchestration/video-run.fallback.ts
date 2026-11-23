import { type ProviderFailure } from "@reelforge/ai-providers";
import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { clearResolvedSubmissionHold } from "../runs/run-outcomes.js";
import { RunsService } from "../runs/runs.service.js";
import type { Context, Run, Scoped, Step } from "../runs/runs.types.js";
import { overheadCents } from "../scene-media/media-prices.js";
import { fallbackEstimate, pinnedBudget } from "../usage-budget/run-envelope.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";

@Injectable()
export class RunFallback {
  public constructor(
    private readonly runs: RunsService,
    private readonly paid: RunPaidCalls,
  ) {}
  /** Only a proven pre-dispatch outage can create another paid attempt. Unknown calls reconcile. */
  public async apply(
    context: Context,
    run: Run,
    failed: Step,
    failure: ProviderFailure,
  ): Promise<void> {
    const result = await this.runs.store.mutate(
      context,
      run.id,
      "fallback",
      async (db, current, tx) => {
        const step = await db.videoRunStep.findFirstOrThrow({ where: { id: failed.id } });
        if (step.state !== "RUNNING" || step.idempotencyKey !== failed.idempotencyKey)
          return { value: true, payload: { replay: true } };
        if (current.state === "CANCELED") return { value: false, payload: { canceled: true } };
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        const estimate = await this.estimate(db, run, step, budget);
        if (!estimate) return { value: false, payload: { fallbackUnavailable: true } };
        await this.paid.settleRejectedRequest(tx, context, step, failure);
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
        await clearResolvedSubmissionHold(db, tx, current, step.id);
        const warning = estimate.baseEstimateMinor > pinnedBudget(run).targetMinor;
        return { value: true, payload: { ...estimate, warning } };
      },
    );
    await this.runs.events?.publish(result.event);
    if (!result.value) {
      const event = await this.paid.finalizeRejected(context, failed, failure);
      await this.runs.events?.publish(event);
    }
  }

  private async estimate(
    db: Scoped,
    run: Run,
    failed: Step,
    budget: Parameters<typeof fallbackEstimate>[0],
  ): Promise<ReturnType<typeof fallbackEstimate> | null> {
    if (
      await db.videoRunStep.findFirst({
        where: { runId: run.id, key: { startsWith: "media:text:critic:" }, state: "FAILED" },
      })
    )
      return null;
    const all = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
    });
    const remaining = all.filter((s) => s.state === "PENDING" || s.id === failed.id);
    const initial = all.filter((s) => s.attempt === 1).map((s) => ShotSpecSchema.parse(s.input));
    const mediaSteps = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "media:" }, state: "SUCCEEDED" },
    });
    const overheadSpent = mediaSteps.reduce((sum, item) => sum + (item.costMinor ?? 0), 0);
    const overhead = Math.max(0, overheadCents(initial) - overheadSpent);
    try {
      return fallbackEstimate(
        { ...budget, reservedMinor: budget.reservedMinor - (failed.costMinor ?? 0) },
        remaining.map((s) => ShotSpecSchema.parse(s.input)),
        overhead,
        pinnedBudget(run).hardCapMinor,
      );
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return null;
    }
  }
}
