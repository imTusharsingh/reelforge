import { z } from "zod";
import { type TextDispatchCheck } from "./text-dispatch-recovery.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import {
  type Admission,
  jobIdFromAdmission,
  readAdmission,
  TEXT_DISPATCH_PROTOCOL,
} from "./run-admission-state.js";
import { assertCriticRevision } from "./critic-admission.js";
import { assertPaidRunLimits } from "./run-envelope.js";
import { releaseAdmission } from "./run-paid-admission.js";
import { DispatchAdmissionError } from "./run-paid-dispatch.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

const protocol = z.object({ textDispatchProtocol: z.literal(TEXT_DISPATCH_PROTOCOL) });
type Started<T> = { response: Promise<T> };

/**
 * Preparation is durable but proves no POST was authorized. Hold the run lock
 * across the final checks, durable arming and synchronous transport initiation.
 * Never wait for the provider response inside that transaction.
 */
export async function beginLockedTextSend<T>(
  store: RunsStore,
  usage: Pick<UsageBudgetService, "release">,
  context: Context,
  claim: Step,
  check: TextDispatchCheck,
  send: () => Promise<T>,
): Promise<Started<T>> {
  let started: Started<T> | undefined;
  try {
    const result = await store.mutate(
      context,
      claim.runId,
      "text_dispatch_started",
      async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: claim.id } });
        const reservation = validateClaim(
          claim,
          current,
          await readAdmission(tx, context, current),
        );
        const reason = await checkSend(db, tx, run, current, reservation, check);
        if (reason) {
          const amountMinor = await releaseAdmission(
            db,
            tx,
            usage,
            context,
            run,
            current,
            reservation.id,
            false,
            true,
          );
          return {
            value: reason,
            payload: { reason, amountMinor },
            eventType: "dispatch_released",
            stepId: claim.id,
          };
        }
        // Arm on the same standalone session that owns the advisory lock.
        if (!check.arm || !(await check.arm(current)))
          throw new DispatchAdmissionError("Text dispatch claim changed");
        // The sync text adapter starts its fetch in this turn, before the first await.
        const response = (async (): Promise<T> => send())();
        void response.catch(() => undefined);
        started = { response };
        return { value: null, payload: { idempotencyKey: claim.idempotencyKey }, stepId: claim.id };
      },
    );
    if (result.value) throw new DispatchAdmissionError(result.value);
  } catch (error) {
    // Arming committed independently before transport. A later failure of the
    // enclosing transaction must not discard the original response.
    if (!started) throw error;
  }
  if (!started) throw new DispatchAdmissionError("Text dispatch did not start");
  return started;
}

function validateClaim(
  claim: Step,
  current: Step,
  admission: Admission,
): NonNullable<Admission["reservation"]> {
  if (
    current.state !== "RUNNING" ||
    current.idempotencyKey !== claim.idempotencyKey ||
    current.providerJobId ||
    jobIdFromAdmission(admission) ||
    !protocol.safeParse(admission.request?.responseMetadata).success ||
    admission.evidence !== "text-prepared" ||
    !admission.reservation ||
    !["RESERVED", "EXPIRED"].includes(admission.reservation.status)
  )
    throw new DispatchAdmissionError("Text dispatch claim changed");
  return admission.reservation;
}

async function checkSend(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  reservation: { status: string; expiresAt: Date },
  check: () => Promise<void>,
): Promise<string | null> {
  if (
    ["CANCELED", "FAILED", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state) ||
    run.pauseReason ||
    reservation.status !== "RESERVED" ||
    reservation.expiresAt.getTime() <= Date.now()
  )
    return "Text dispatch claim changed before POST";
  try {
    await assertCriticRevision(db, tx, run, step);
    await assertPaidRunLimits(db, run, step.costMinor ?? 0, step.id);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return "Text dispatch admission changed before POST";
  }
  try {
    await check();
    return null;
  } catch {
    return "Ownership lost before dispatch";
  }
}
