import { ConflictException } from "@nestjs/common";
import { acceptedAudio } from "../runs/run-audio.js";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Run } from "../runs/runs.types.js";
import { SAVED_CAPTION_PLAN_UNUSABLE } from "../usage-budget/run-caption-admission.js";

export function isSavedCaptionRejection(error: unknown): error is ConflictException {
  if (!(error instanceof ConflictException)) return false;
  const response = error.getResponse();
  return (
    typeof response === "object" &&
    "code" in response &&
    response.code === SAVED_CAPTION_PLAN_UNUSABLE
  );
}

/** Stop new assembly work durably. The normal paused-run path drains admitted audio by ID. */
export async function pauseRejectedAssembly(
  runs: RunsService,
  context: Context,
  run: Run,
  message: string,
): Promise<number | null> {
  const code = SAVED_CAPTION_PLAN_UNUSABLE;
  const result = await runs.store.mutate(
    context,
    run.id,
    "assembly_input_invalid",
    async (db, current) => {
      if (current.state !== "ASSEMBLING" || current.pauseReason)
        return { value: false, payload: { stale: true } };
      const changed = await db.videoRunStep.updateMany({
        where: { runId: run.id, key: "ASSEMBLING", attempt: 1, state: "RUNNING" },
        data: { state: "FAILED", finishedAt: new Date(), error: { code, message } },
      });
      if (!changed.count) return { value: false, payload: { stale: true } };
      await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: code } });
      return { value: true, payload: { code, message } };
    },
  );
  await runs.events?.publish(result.event);
  if (!result.value) return null;
  return (await acceptedAudio(runs.store.scoped(context), runs.store.db, run)).length
    ? 12000
    : null;
}
