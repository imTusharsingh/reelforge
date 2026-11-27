import { z } from "zod";
import type { LocalAssemblyFailure } from "../composition/local-assembly-failure.js";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Run } from "../runs/runs.types.js";

const attempts = z.object({ localRenderFailures: z.number().int().nonnegative() });
const retryDelays = [5000, 15000];

export async function recordAssemblyFailure(
  runs: RunsService,
  context: Context,
  run: Run,
  failure: LocalAssemblyFailure,
): Promise<number | null> {
  const result = await runs.store.mutate(
    context,
    run.id,
    "assembly_local_failure",
    async (db, current) => {
      if (current.state !== "ASSEMBLING" || current.pauseReason)
        return { value: null, payload: { stale: true } };
      const step = await db.videoRunStep.findFirst({
        where: { runId: run.id, key: "ASSEMBLING", attempt: 1, state: "RUNNING" },
      });
      if (!step) return { value: null, payload: { stale: true } };
      const prior = attempts.safeParse(step.error).data?.localRenderFailures ?? 0;
      const delay = failure.retryable ? (retryDelays[prior] ?? null) : null;
      const error = {
        code: delay === null && failure.retryable ? "LOCAL_RENDER_RETRIES_EXHAUSTED" : failure.code,
        message: failure.message,
        localRenderFailures: prior + 1,
      };
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: {
          error,
          ...(delay === null ? { state: "FAILED", finishedAt: new Date() } : {}),
        },
      });
      if (delay === null)
        await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: error.code } });
      return { value: delay, payload: { ...error, retryInMs: delay }, stepId: step.id };
    },
  );
  await runs.events?.publish(result.event);
  return result.value;
}
