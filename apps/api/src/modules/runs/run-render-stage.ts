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
