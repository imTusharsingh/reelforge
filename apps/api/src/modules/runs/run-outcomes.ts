import type { Run, Scoped, Step, Transaction } from "./runs.types.js";

export const PLANNING_MANIFEST_KEY = "planning:manifest:v1";
export const DISPATCHING = "VIDEO_RUN_DISPATCHING";
export const OUTCOME_UNKNOWN = "VIDEO_RUN_OUTCOME_UNKNOWN";
export const PROTECTED_OUTCOMES = [DISPATCHING, OUTCOME_UNKNOWN];
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

export async function clearResolvedSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
  stepId: string,
): Promise<string | null> {
  if (!run.pauseReason?.startsWith("RECONCILE_REQUIRED") || !run.pauseReason.includes(stepId))
    return run.pauseReason;
  const unresolved = await db.videoRunStep.findMany({
    where: { runId: run.id, id: { not: stepId }, state: "RUNNING", providerJobId: null },
    select: { id: true },
  });
  const other = await tx.providerRequest.findFirst({
    where: {
      workspaceId: run.workspaceId,
      correlationId: { in: unresolved.map(({ id }) => id) },
      errorCode: { in: PROTECTED_OUTCOMES },
    },
  });
  const pauseReason = other
    ? `RECONCILE_REQUIRED: provider submission outcome unknown (${other.correlationId})`
    : null;
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
