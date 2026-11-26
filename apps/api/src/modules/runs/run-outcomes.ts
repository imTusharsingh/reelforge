import { correctionHold, pendingCorrectionWhere } from "../usage-budget/run-pending-receipt.js";
import { criticPrefix } from "../usage-budget/critic-admission.js";
import { QualityRubricSchema, type ShotSpec } from "@reelforge/contracts";
import {
  canRollback,
  jobIdFromAdmission,
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

/** An unkeyed overage can predate all per-shot billing markers. */
async function stoppedLegacyBillingHold(db: Scoped, runId: string, open: Step[]): Promise<boolean> {
  const stop = await db.runEvent.findFirst({
    where: { runId, type: "emergency_stop", payload: { path: ["entered"], equals: true } },
    orderBy: { sequence: "desc" },
    select: { payload: true, sequence: true },
  });
  const payload = stop?.payload;
  if (
    !stop ||
    !payload ||
    typeof payload !== "object" ||
    !("priorPauseReason" in payload) ||
    payload.priorPauseReason !== legacyBillingHold
  )
    return false;
  // The old hold names no shot. Drain accepted shots and require a real overage settlement.
  if (open.some((step) => step.key.startsWith("shot-") && step.providerJobId)) return true;
  const settled = await db.runEvent.findFirst({
    where: {
      runId,
      type: "billing_reconciled",
      stepId: { not: null },
      sequence: { gt: stop.sequence },
    },
    select: { id: true },
  });
  return !settled;
}

export async function remainingSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<string | null> {
  const correction = await db.videoRunStep.findFirst({
    where: { runId: run.id, ...pendingCorrectionWhere },
    select: { id: true },
  });
  if (correction) return correctionHold(correction.id);
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
  if (
    run.pauseReason === legacyBillingHold ||
    (run.pauseReason === "EMERGENCY_STOP" && (await stoppedLegacyBillingHold(db, run.id, steps)))
  )
    return legacyBillingHold;
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
export async function releaseSteps(
  workspaceId: string,
  db: Scoped,
  tx: Transaction,
  runId: string,
  steps: Step[],
  reason: "RUN_CANCELED" | "OPERATOR_ABANDONED" | "CRITIC_SUPERSEDED" | "CRITIC_REJECTED",
): Promise<void> {
  if (!steps.length) return;
  const ids = steps.map((step) => step.id);
  await tx.usageReservation.updateMany({
    where: {
      workspaceId,
      idempotencyKey: { in: steps.map((step) => `m08:${step.idempotencyKey}`) },
      status: "RESERVED",
    },
    data: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason },
  });
  await tx.providerRequest.updateMany({
    where: {
      workspaceId,
      correlationId: { in: ids },
      status: "FAILED",
      actualCost: null,
    },
    data: {
      errorCode: reason,
      actualCost: 0,
      responseMetadata: { dispatched: false, costKnown: true },
    },
  });
  await db.videoRunStep.updateMany({
    where: { runId, id: { in: ids } },
    data: { state: "CANCELLED", finishedAt: new Date(), output: { closedBy: reason } },
  });
  const refunded = steps
    .filter((step) => step.state === "RUNNING")
    .reduce((sum, step) => sum + (step.costMinor ?? 0), 0);
  if (!refunded) return;
  const budget = await db.budgetEnvelope.findFirst({ where: { runId } });
  if (budget) {
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: {
        reservedMinor: Math.max(0, budget.reservedMinor - refunded),
        revision: budget.revision + 1,
      },
    });
  }
}

/** A terminal critic may race a legacy replacement. Fence every unsubmitted child under the run lock. */
async function closeUnsubmittedShots(db: Scoped, tx: Transaction, run: Run): Promise<void> {
  const steps = await db.videoRunStep.findMany({
    where: { ...unsettledShots(run.id), providerJobId: null },
  });
  const claims = await readAdmissions(db, tx, run.workspaceId, steps);
  const safe = claims.filter(
    (claim) => canRollback(claim) || claim.evidence === "released-nondispatch",
  );
  await releaseSteps(
    run.workspaceId,
    db,
    tx,
    run.id,
    safe.map(({ step }) => step),
    "CRITIC_REJECTED",
  );
}

export async function collectibleFailedShots(
  db: Scoped,
  tx: Transaction,
  run: Run,
  id?: string,
): Promise<Step[]> {
  const steps = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      ...(id && { id }),
      key: { startsWith: "shot-" },
      OR: [{ state: { in: ["RUNNING", "WAITING_EXTERNAL"] } }, pendingCorrectionWhere],
    },
  });
  const claims = await readAdmissions(db, tx, run.workspaceId, steps);
  return claims
    .filter(({ step, ...claim }) =>
      step.state === "RUNNING" ? !!jobIdFromAdmission(claim) : !!step.providerJobId,
    )
    .map(({ step }) => step);
}

export async function failRunIfSettled(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  error: { code: string; message: string },
): Promise<void> {
  if (step.key.startsWith(criticPrefix) && run.state !== "CANCELED")
    await closeUnsubmittedShots(db, tx, run);
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
