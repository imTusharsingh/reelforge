import type { RunsService } from "../runs/runs.service.js";
import { closeSteps } from "../runs/run-close-steps.js";
import { SETTLED_SHOTS, storedSubmissionHold } from "../runs/run-outcomes.js";
import type { Context, Run, Scoped, Transaction } from "../runs/runs.types.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";

export const textCancellationRequested = "CANCEL_REQUESTED";
class CancellationNotReady extends Error {}

export async function closeTextAdmissionForCancel(
  context: Context,
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<boolean> {
  const attempts = await db.videoRunStep.findMany({
    where: { runId: run.id, key: { startsWith: "media:text:" } },
    orderBy: { id: "asc" },
  });
  let pending = false;
  for (const attempt of attempts) {
    const current = await lockTextAttempt(tx, context.workspaceId, attempt.id);
    const evidence = await readTextAttempt(tx, current);
    if (!evidence) continue;
    if (evidence.phase === "PREPARED" && !evidence.armNonce) {
      await appendTextEvidence(tx, current, {
        kind: "NOT_DISPATCHED",
        eventKey: "cancel-prepared",
        data: { dispatchKey: current.idempotencyKey, source: "reconciler" },
      });
      await foldTextAttempt(tx, context, current.id);
    } else if (
      evidence.armNonce &&
      !evidence.positiveSent &&
      !evidence.senderRetired &&
      !["NOT_DISPATCHED", "REJECTED", "SUCCEEDED"].includes(evidence.phase)
    ) {
      pending = true;
    }
  }
  return pending;
}

export async function completeCancellationLocked(
  context: Context,
  db: Scoped,
  tx: Transaction,
  run: Run,
): Promise<void> {
  const steps = await db.videoRunStep.findMany({
    where: { runId: run.id, state: { notIn: [...SETTLED_SHOTS] }, providerJobId: null },
  });
  // The text journal owns any prepared or armed text attempt; never release it
  // based on the mutable legacy request status.
  const tracked = await tx.textAttemptEvidence.findMany({
    where: {
      workspaceId: context.workspaceId,
      attemptId: { in: steps.map((step) => step.id) },
      kind: "PREPARED",
    },
    select: { attemptId: true },
  });
  const textIds = new Set(tracked.map((row) => row.attemptId));
  const hold = await closeSteps(
    context,
    db,
    tx,
    run,
    steps.filter((step) => !textIds.has(step.id)),
    "RUN_CANCELED",
  );
  await db.videoRun.updateMany({
    where: { id: run.id },
    data: {
      state: "CANCELED",
      pauseReason: hold ?? (await storedSubmissionHold(db, run.id, run.pauseReason)),
    },
  });
}

export async function maybeCompleteTextCancellation(
  runs: Pick<RunsService, "store" | "events">,
  context: Context,
  runId: string,
): Promise<void> {
  if ((await runs.store.get(context, runId)).pauseReason !== textCancellationRequested) return;
  try {
    const result = await runs.store.mutate(context, runId, "transition", async (db, run, tx) => {
      if (
        run.pauseReason !== textCancellationRequested ||
        (await closeTextAdmissionForCancel(context, db, tx, run))
      )
        throw new CancellationNotReady();
      await completeCancellationLocked(context, db, tx, run);
      return { value: null, payload: { from: run.state, to: "CANCELED" } };
    });
    await runs.events?.publish(result.event);
  } catch (error) {
    if (!(error instanceof CancellationNotReady)) throw error;
  }
}
