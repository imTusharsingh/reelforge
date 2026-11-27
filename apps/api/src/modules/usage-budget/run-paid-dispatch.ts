import { ConflictException } from "@nestjs/common";
import { AUDIO_KEYS, failedAudio } from "../runs/run-audio.js";
import { submissionHold } from "../runs/run-outcomes.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Step } from "../runs/runs.types.js";
import {
  assertPinnedVideoRunLanguage,
  preparePinnedVideoRunLanguage,
} from "../composition/video-run-language.js";
import { assertCriticRevision } from "./critic-admission.js";
import { assertPaidRunLimits } from "./run-envelope.js";
import { DISPATCHING, readAdmission, TEXT_DISPATCH_PROTOCOL } from "./run-admission-state.js";

export class DispatchAdmissionError extends ConflictException {}

export async function markDispatching(
  store: RunsStore,
  context: Context,
  step: Step,
  assertLocked?: () => Promise<void>,
): Promise<void> {
  const prepared = await preparePinnedVideoRunLanguage(
    async () => (await store.get(context, step.runId)).inputSnapshot,
  );
  await store.mutate(context, step.runId, "provider_dispatch", async (db, run, tx) => {
    assertPinnedVideoRunLanguage(run.inputSnapshot, prepared);
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (
      ["CANCELED", "FAILED", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state) ||
      ["OPERATOR_ABANDONED", "EMERGENCY_STOP"].some((reason) => run.pauseReason === reason) ||
      current.state !== "RUNNING" ||
      current.idempotencyKey !== step.idempotencyKey ||
      run.pauseReason?.startsWith("RECONCILE_REQUIRED")
    )
      throw new DispatchAdmissionError("Paid dispatch is closed");
    if (AUDIO_KEYS.includes(current.key) && (await failedAudio(db, run.id)))
      throw new DispatchAdmissionError("Required audio input failed");
    await assertCriticRevision(db, tx, run, current);
    await assertPaidRunLimits(db, run, current.costMinor ?? 0, current.id);
    const { reservation, evidence } = await readAdmission(tx, context, current);
    if (reservation?.status !== "RESERVED" || reservation.expiresAt.getTime() <= Date.now())
      throw new DispatchAdmissionError("Paid dispatch reservation is inactive");
    if (evidence !== "pending") throw new ConflictException(submissionHold(step.id));
    const lockedText = current.key.startsWith("media:text:") && assertLocked !== undefined;
    if (lockedText) await checkDispatchLock(assertLocked);
    const marked = await tx.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: "PENDING" },
      data: {
        errorCode: DISPATCHING,
        responseMetadata: {
          dispatched: true,
          costKnown: false,
          ...(lockedText && { textDispatchProtocol: TEXT_DISPATCH_PROTOCOL }),
        },
      },
    });
    if (!marked.count) throw new ConflictException("Paid dispatch requires reconciliation");
    // Keep the final check inside the transaction. Failure proves no POST and rolls
    // the marker back before an orphan sweep or owner confirmation can see it.
    if (assertLocked) await checkDispatchLock(assertLocked);
    return { value: null, payload: { idempotencyKey: step.idempotencyKey }, stepId: step.id };
  });
}

async function checkDispatchLock(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (cause) {
    throw new DispatchAdmissionError("Ownership lost before dispatch", { cause });
  }
}
