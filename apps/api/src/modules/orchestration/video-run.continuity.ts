import type { ShotSpec } from "@reelforge/contracts";
import { SETTLED_SHOTS, failSettledGeneration } from "../runs/run-outcomes.js";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Run, Step } from "../runs/runs.types.js";

export async function waitForShotContinuity(
  runs: RunsService,
  context: Context,
  run: Run,
  step: Step,
  source: ShotSpec["firstFrameFrom"],
): Promise<number | null | undefined> {
  if (step.state !== "PENDING" || !source || !("previousShotOrdinal" in source)) return undefined;
  const previous = await runs.store.scoped(context).videoRunStep.findFirstOrThrow({
    where: { runId: run.id, key: `shot-${source.previousShotOrdinal}` },
    orderBy: { attempt: "desc" },
  });
  if (previous.state === "SUCCEEDED") return undefined;
  if (!SETTLED_SHOTS.some((state) => state === previous.state)) return 12000;
  const result = await runs.store.mutate(context, run.id, "step_skipped", async (db, current) => {
    const changed = await db.videoRunStep.updateMany({
      where: { id: step.id, state: "PENDING" },
      data: {
        state: "SKIPPED",
        finishedAt: new Date(),
        error: { code: "CONTINUITY_SOURCE_UNAVAILABLE" },
      },
    });
    if (changed.count) await failSettledGeneration(db, current);
    return {
      value: changed.count ? null : 12000,
      payload: { sourceStepId: previous.id },
      stepId: step.id,
    };
  });
  await runs.events?.publish(result.event);
  return result.value;
}
