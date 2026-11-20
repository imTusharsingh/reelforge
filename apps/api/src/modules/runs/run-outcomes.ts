import { canRollback, readAdmissions } from "../usage-budget/run-admission-state.js";
import type { Run, Scoped, Step, Transaction } from "./runs.types.js";

export const PLANNING_MANIFEST_KEY = "planning:manifest:v1";
export const SETTLED_SHOTS = ["SUCCEEDED", "SKIPPED", "CANCELLED", "FAILED"] as const;

export function unsettledShots(runId: string): {
  runId: string;
  key: { startsWith: string };
  state: { notIn: Step["state"][] };
} {
  return {
    runId,
    key: { startsWith: "shot-" },
    state: { notIn: [...SETTLED_SHOTS] },
  };
}

export function submissionHold(stepId: string): string {
  return `RECONCILE_REQUIRED: provider submission outcome unknown (${stepId})`;
}

export async function remainingSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<string | null> {
  const steps = await db.videoRunStep.findMany({
    where: { runId: run.id, state: { notIn: [...SETTLED_SHOTS] }, providerJobId: null },
    select: { id: true, idempotencyKey: true },
  });
  const admissions = await readAdmissions(tx, run.workspaceId, steps);
  const other = admissions.find((admission) => !canRollback(admission));
  return other ? submissionHold(other.step.id) : null;
}

export async function clearResolvedSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
  stepId: string,
): Promise<string | null> {
  if (!run.pauseReason?.startsWith("RECONCILE_REQUIRED") || !run.pauseReason.includes(stepId))
    return run.pauseReason;
  const pauseReason = await remainingSubmissionHold(db, tx, run);
  await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason } });
  return pauseReason;
}

export async function failSettledGeneration(db: Scoped, run: Run): Promise<boolean> {
  if (
    !["GENERATING", "PAUSED_BUDGET"].includes(run.state) ||
    run.pauseReason?.startsWith("RECONCILE_REQUIRED")
  )
    return false;
  if (await db.videoRunStep.findFirst({ where: unsettledShots(run.id) })) return false;
  const failed = await db.videoRunStep.findFirst({
    where: { runId: run.id, key: { startsWith: "shot-" }, state: "FAILED" },
    orderBy: { key: "asc" },
  });
  if (!failed) return false;
  const error = failed.error;
  const reason =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "PROVIDER_FAILED";
  await db.videoRun.updateMany({
    where: { id: run.id },
    data: {
      state: "FAILED",
      pauseReason: reason,
      ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
    },
  });
  return true;
}
