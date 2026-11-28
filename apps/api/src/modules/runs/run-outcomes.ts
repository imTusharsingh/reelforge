import { terminalVideo, terminalVideoWhere } from "../usage-budget/run-video-terminal.js";
import { terminalRenderFailure } from "./run-render-stage.js";
import { MissingVideoPricing } from "../scene-media/media-prices.js";
import { releaseSteps } from "./run-close-steps.js";
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
  if (!step.key.startsWith("media:text:")) return !!step.providerJobId;
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
  const missingPrice = steps.find(
    ({ error }) =>
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === MissingVideoPricing.code,
  );
  if (missingPrice) return MissingVideoPricing.hold(missingPrice.id);
  if (
    run.pauseReason === legacyBillingHold ||
    (run.pauseReason === "EMERGENCY_STOP" && (await stoppedLegacyBillingHold(db, run.id, steps)))
  )
    return legacyBillingHold;
  const other = admissions.find(
    ({ step, ...admission }) =>
      !recoverableJob(step) && (!!step.providerJobId || !canRollback(admission)),
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
  if (
    recoverableJob(step) &&
    !reason.startsWith("RECONCILE_REQUIRED: provider billing") &&
    !reason.startsWith("RECONCILE_REQUIRED: missing admission video pricing")
  )
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

export async function mayRecordSubmissionHold(db: Scoped, run: Run): Promise<boolean> {
  return (
    run.pauseReason !== "EMERGENCY_STOP" &&
    run.pauseReason !== "CANCEL_REQUESTED" &&
    !(await terminalRenderFailure(db, run))
  );
}

export async function recordShotBillingHold(db: Scoped, run: Run, stepId: string): Promise<void> {
  if (await mayRecordSubmissionHold(db, run))
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { pauseReason: billingHold(stepId) },
    });
}

export async function clearResolvedSubmissionHold(
  db: Scoped,
  tx: Transaction,
  run: Run,
  stepId: string,
): Promise<string | null> {
  const reason = run.pauseReason;
  if (reason === "EMERGENCY_STOP" || reason === "CANCEL_REQUESTED") return reason;
  const terminal = await terminalRenderFailure(db, run);
  const durable = terminal ? null : await remainingSubmissionHold(db, tx, run);
  const pauseReason =
    terminal?.code ??
    durable ??
    (reason?.startsWith("RECONCILE_REQUIRED")
      ? reason.includes(stepId)
        ? null
        : await storedSubmissionHold(db, run.id, reason)
      : reason);
  if (pauseReason !== reason)
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason } });
  return pauseReason;
}

/** The first permanent input failure owns the run diagnostic while accepted siblings drain. */
export function generationFailure(db: Scoped, runId: string): Promise<Step | null> {
  return db.videoRunStep.findFirst({
    where: {
      runId,
      key: { startsWith: "shot-" },
      state: "FAILED",
      error: { path: ["closesGeneration"], equals: true },
    },
    orderBy: [{ finishedAt: "asc" }, { key: "asc" }],
  });
}

export async function failSettledGeneration(db: Scoped, run: Run): Promise<boolean> {
  if (
    !["GENERATING", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state) ||
    run.pauseReason?.startsWith("RECONCILE_REQUIRED")
  )
    return false;
  if (await db.videoRunStep.findFirst({ where: unsettledShots(run.id) })) return false;
  const permanent = await generationFailure(db, run.id);
  if (run.state === "NEEDS_HUMAN" && !permanent) return false;
  if (
    permanent &&
    (await db.videoRunStep.findFirst({
      where: {
        runId: run.id,
        key: { startsWith: "media:keyframe:" },
        state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
      },
    }))
  )
    return false;
  const failed =
    permanent ??
    (await db.videoRunStep.findFirst({
      where: {
        runId: run.id,
        OR: [{ key: { startsWith: "shot-" } }, { key: { startsWith: "media:text:critic:" } }],
        state: "FAILED",
      },
      orderBy: { key: "asc" },
    }));
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

export const referenceMediaPrefix = "media:reference:";

/** A failed run may settle admitted receipts, but must not start another provider job. */
export async function collectibleFailedSteps(
  db: Scoped,
  tx: Transaction,
  run: Run,
  id?: string,
): Promise<Step[]> {
  const steps = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      ...(id && { id }),
      OR: [
        {
          key: { startsWith: "shot-" },
          OR: [
            { state: { in: ["RUNNING", "WAITING_EXTERNAL"] } },
            pendingCorrectionWhere,
            terminalVideoWhere,
          ],
        },
        {
          key: { startsWith: referenceMediaPrefix },
          state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
        },
      ],
    },
  });
  const claims = await readAdmissions(db, tx, run.workspaceId, steps);
  return claims
    .filter(
      ({ step, ...claim }) =>
        !!terminalVideo(step) ||
        (step.state === "RUNNING" ? !!jobIdFromAdmission(claim) : !!step.providerJobId),
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
