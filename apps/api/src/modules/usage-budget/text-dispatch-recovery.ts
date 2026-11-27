import { withSessionLock } from "../runs/session-lock.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Step } from "../runs/runs.types.js";
import { DISPATCHING, OUTCOME_UNKNOWN } from "./run-admission-state.js";
import { remainingSubmissionHold, submissionHold } from "../runs/run-outcomes.js";

const lockKey = (step: Step): string => `sync-text:${step.id}`;
export function withTextDispatch<T>(step: Step, work: (check: () => Promise<void>) => Promise<T>): Promise<T> {
  return withSessionLock(lockKey(step), "rf-sync-text", "Text dispatch in progress", "Text dispatcher lost ownership", work);
}

class ActiveOrSettled extends Error {}

/** A session lock dies with its worker. Take the same lock before fencing the
 * ledger marker, so a slow but live POST can still finish normally. */
export async function recoverTextDispatches(store: RunsStore, context: Context): Promise<void> {
  const requests = await store.db.providerRequest.findMany({
    where: { workspaceId: context.workspaceId, errorCode: DISPATCHING },
    select: { correlationId: true },
  });
  if (!requests.length) return;
  const steps = await store.scoped(context).videoRunStep.findMany({
    where: { id: { in: requests.map(r => r.correlationId) }, key: { startsWith: "media:text:" }, state: "RUNNING", providerJobId: null },
  });
  for (const step of steps) {
    try {
      await store.mutate(context, step.runId, "reconcile_required", async (db, run, tx) => {
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(step)},0)) AS acquired`;
        if (!lock?.acquired) throw new ActiveOrSettled();
        const current = await db.videoRunStep.findFirst({where: { id: step.id, state:"RUNNING", providerJobId:null }});
        if (!current) throw new ActiveOrSettled();
        const changed = await tx.providerRequest.updateMany({
          where: {workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING},
          data: {errorCode: OUTCOME_UNKNOWN},
        });
        if (!changed.count) throw new ActiveOrSettled();
        const reason = await remainingSubmissionHold(db, tx, run) ?? submissionHold(step.id);
        if (!run.pauseReason || run.pauseReason.startsWith("RECONCILE_REQUIRED"))
          await db.videoRun.updateMany({where: {id:run.id}, data: {pauseReason:reason}});
        return {value:null, payload:{ reason, orphanedDispatch:true }, stepId:step.id};
      });
    } catch (error) {
      if (!(error instanceof ActiveOrSettled)) throw error;
    }
  }
}
