import { failedScriptValidation, isScriptRepair, repairMessage } from "../script/script-repair.js";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import type { Run, Context, Step } from "../runs/runs.types.js";
import type { MediaAccess } from "./media-access.js";

export async function checkPlanningFailures(
  access: MediaAccess,
  context: Context,
  run: Run,
  planningKeys: string[],
): Promise<void> {
  const rejected = await access.runs.store.scoped(context).videoRunStep.findMany({
    where: { runId: run.id, key: { in: planningKeys }, state: "FAILED" },
  });
  for (const step of rejected) {
    if (!isScriptRepair(step)) continue;
    const message = failedScriptValidation(step);
    if (message) {
      await rejectSavedOutput(access, context, step, { code: "SCRIPT_VALIDATION", message });
      throw new Error(message);
    }
  }
  if (rejected.some((step) => !repairMessage(step)))
    throw new Error("Planning provider request was rejected");
}

// Legacy receipts have already settled. Preserve their output and ledger entries.
export async function rejectSavedOutput(
  access: MediaAccess,
  context: Context,
  step: Step,
  error: { code: string; message: string },
): Promise<void> {
  const result = await access.runs.store.mutate(
    context,
    step.runId,
    "planning_invalid",
    async (db, run) => {
      if (run.state !== "SCRIPTING" || run.pauseReason)
        return { value: null, payload: { stale: true } };
      await db.videoRunStep.updateMany({
        where: { id: step.id, state: { in: ["SUCCEEDED", "WAITING_EXTERNAL"] } },
        data: { state: "FAILED", error, finishedAt: new Date() },
      });
      if (error.code === "SCRIPT_VALIDATION" && !isScriptRepair(step))
        return { value: null, payload: { reason: error.code }, stepId: step.id };
      await db.videoRunStep.updateMany({
        where: {
          runId: run.id,
          key: { in: ["SCRIPTING", PLANNING_MANIFEST_KEY] },
          state: "RUNNING",
        },
        data: { state: "FAILED", error, finishedAt: new Date() },
      });
      await db.videoRun.updateMany({
        where: { id: run.id },
        data: {
          state: "FAILED",
          pauseReason: error.code,
          ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
        },
      });
      return { value: null, payload: { reason: error.code }, stepId: step.id };
    },
  );
  await access.runs.events?.publish(result.event);
}
