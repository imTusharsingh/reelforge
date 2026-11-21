import { criticPrefix } from "../usage-budget/critic-admission.js";
import { QualityRubricSchema, type ShotSpec } from "@reelforge/contracts";
import {
  canRollback,
  readAdmissions,
  attachedTextResult,
} from "../usage-budget/run-admission-state.js";
import type { Run, Scoped, Step, Transaction } from "./runs.types.js";

export const PLANNING_MANIFEST_KEY = "planning:manifest:v1";
export const SETTLED_SHOTS = ["SUCCEEDED", "SKIPPED", "CANCELLED", "FAILED"] as const;

export function keyframeKey(shot: ShotSpec): string {
  return `keyframe:${shot.ordinal}:v${shot.version}`;
}

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

function recoverableJob(step: Step): boolean {
  if (!step.providerJobId) return false;
  if (!step.key.startsWith("media:text:")) return true;
  const result = attachedTextResult(step);
  return (
    !!result &&
    (!step.key.startsWith("media:text:critic:") ||
      QualityRubricSchema.safeParse(result.output).success)
  );
}

const legacyBillingHold = "RECONCILE_REQUIRED: provider billing exceeded reservation";

export async function remainingSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<string | null> {
  const steps = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      state: { notIn: [...SETTLED_SHOTS] },
      OR: [{ key: { startsWith: "media:" } }, { key: { startsWith: "shot-" } }],
    },
  });
  const admissions = await readAdmissions(db, tx, run.workspaceId, steps);
  const billing = admissions.find(({ evidence }) => evidence === "billing-overage");
  if (billing) return billingHold(billing.step.id);
  if (run.pauseReason === legacyBillingHold) return legacyBillingHold;
  const other = admissions.find(({ step, ...admission }) =>
    step.providerJobId ? !recoverableJob(step) : !canRollback(admission),
  );
  return other ? submissionHold(other.step.id) : null;
}

export function billingHold(stepId: string): string {
  return `RECONCILE_REQUIRED: provider billing exceeded reservation (${stepId})`;
}

export async function storedSubmissionHold(
  db: Scoped,
  runId: string,
  reason: string | null,
): Promise<string | null> {
  if (!reason?.startsWith("RECONCILE_REQUIRED")) return null;
  const stepId = /\(([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\)$/i.exec(reason)?.[1];
  if (!stepId) return reason;
  const step = await db.videoRunStep.findFirst({ where: { runId, id: stepId } });
  if (!step) return reason;
  if (SETTLED_SHOTS.some((state) => step.state === state)) return null;
  if (recoverableJob(step) && !reason.startsWith("RECONCILE_REQUIRED: provider billing"))
    return null;
  return reason;
}

export async function activeSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<string | null> {
  return (
    (await remainingSubmissionHold(db, tx, run)) ??
    storedSubmissionHold(db, run.id, run.pauseReason)
  );
}

export async function clearResolvedSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
  stepId: string,
): Promise<string | null> {
  const reason = run.pauseReason;
  const durable = await remainingSubmissionHold(db, tx, run);
  const pauseReason =
    durable ??
    (reason?.startsWith("RECONCILE_REQUIRED")
      ? reason.includes(stepId)
        ? null
        : await storedSubmissionHold(db, run.id, reason)
      : reason);
  if (reason === "EMERGENCY_STOP") return reason;
  if (pauseReason !== reason)
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
    where: {
      runId: run.id,
      OR: [{ key: { startsWith: "shot-" } }, { key: { startsWith: "media:text:critic:" } }],
      state: "FAILED",
    },
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
export async function failRunIfSettled(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  error: { code: string; message: string },
): Promise<void> {
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  if (step.key.startsWith("shot-")) {
    await failSettledGeneration(db, { ...run, pauseReason });
  } else if (step.key.startsWith(criticPrefix) && run.state !== "CANCELED") {
    const openShot = await db.videoRunStep.findFirst({
      where: {
        runId: run.id,
        key: { startsWith: "shot-" },
        state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
      },
    });
    if (openShot || ["GENERATING", "PAUSED_BUDGET"].includes(run.state)) {
      // Older workers could dispatch a critic after a reshoot was accepted.
      await db.videoRunStep.updateMany({
        where: { runId: run.id, key: "CRITIC", state: "RUNNING" },
        data: { state: "FAILED", finishedAt: new Date(), error },
      });
      if (run.state === "CRITIC")
        await db.videoRun.updateMany({ where: { id: run.id }, data: { state: "GENERATING" } });
      await failSettledGeneration(db, {
        ...run,
        state: run.state === "CRITIC" ? "GENERATING" : run.state,
        pauseReason,
      });
      return;
    }
    await failTextStage(db, run, error);
  } else if (step.key.startsWith("media:text:") && run.state !== "CANCELED") {
    await failTextStage(db, run, error);
  }
}

async function failTextStage(
  db: Scoped,
  run: Run,
  error: { code: string; message: string },
): Promise<void> {
  await db.videoRunStep.updateMany({
    where: {
      runId: run.id,
      key: { in: [run.state, PLANNING_MANIFEST_KEY] },
      state: "RUNNING",
    },
    data: { state: "FAILED", finishedAt: new Date(), error },
  });
  await db.videoRun.updateMany({
    where: { id: run.id },
    data: {
      state: "FAILED",
      pauseReason: error.code,
      ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
    },
  });
}
