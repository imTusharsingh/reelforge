import { z } from "zod";
import type { Run, Scoped } from "./runs.types.js";

export function isRenderStage(state: Run["state"]): state is "ASSEMBLING" | "CRITIC" {
  return state === "ASSEMBLING" || state === "CRITIC";
}

export async function hasOpenRenderStage(
  db: Scoped,
  current: Run,
  expected: Run["state"],
): Promise<boolean> {
  if (current.state !== expected || current.pauseReason || !isRenderStage(expected)) return false;
  return !!(await db.videoRunStep.findFirst({
    where: { runId: current.id, key: expected, attempt: 1, state: "RUNNING" },
    select: { id: true },
  }));
}

export function pendingRenderEdit(db: Scoped, runId: string): Promise<{ id: string } | null> {
  return db.videoRunStep.findFirst({
    where: { runId, key: "REEDIT", state: "PENDING" },
    select: { id: true },
  });
}

export async function canAdvancePastRender(
  db: Scoped,
  run: Run,
  next: Run["state"],
): Promise<boolean> {
  if (
    !(run.state === "ASSEMBLING" && next === "CRITIC") &&
    !(run.state === "CRITIC" && next === "AWAITING_APPROVAL")
  )
    return true;
  if (run.pauseReason || (run.state === "CRITIC" && (await pendingRenderEdit(db, run.id))))
    return false;
  return !!(await db.videoRunStep.findFirst({
    where: { runId: run.id, key: run.state, attempt: 1, state: "SUCCEEDED" },
    select: { id: true },
  }));
}

export const SAVED_CAPTION_PLAN_UNUSABLE = "SAVED_CAPTION_PLAN_UNUSABLE";
const terminalError = z.object({ code: z.string().min(1), message: z.string().optional() });

export async function terminalRenderFailure(
  db: Scoped,
  run: Run,
): Promise<z.infer<typeof terminalError> | undefined> {
  if (!isRenderStage(run.state)) return;
  const step = await db.videoRunStep.findFirst({
    where: {
      runId: run.id,
      key: run.state,
      state: "FAILED",
      OR: [
        { error: { path: ["code"], equals: SAVED_CAPTION_PLAN_UNUSABLE } },
        { error: { path: ["localRenderFailures"], gt: 0 } },
      ],
    },
    select: { error: true },
  });
  return terminalError.safeParse(step?.error).data;
}
