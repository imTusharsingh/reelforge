import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import {
  type Admission,
  DISPATCHING,
  jobIdFromAdmission,
  OUTCOME_UNKNOWN,
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
 * The marker is already durable. Serialize actual POST initiation with orphan
 * recovery and owner confirmation on the run lock, but never wait for the
 * provider response in that transaction.
 */
export async function beginLockedTextSend<T>(
  store: RunsStore,
  usage: Pick<UsageBudgetService, "release">,
  context: Context,
  claim: Step,
  check: () => Promise<void>,
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
        const { code, reservation } = validateClaim(
          claim,
          current,
          await readAdmission(tx, context, current),
        );
        const reason = await checkSend(db, tx, run, current, code, reservation, check);
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
        // The sync text adapter starts its fetch in this turn, before the first await.
        const response = send();
        void response.catch(() => undefined);
        started = { response };
        return { value: null, payload: { dispatchKey: claim.idempotencyKey }, stepId: claim.id };
      },
    );
    if (result.value) throw new DispatchAdmissionError(result.value);
  } catch (error) {
    // A database failure after initiation is not proof of non-dispatch. The first
    // transaction committed the marker, so still collect the original response.
    if (!started) throw error;
  }
  if (!started) throw new DispatchAdmissionError("Text dispatch did not start");
  return started;
}

function validateClaim(
  claim: Step,
  current: Step,
  admission: Admission,
): {
  code: typeof DISPATCHING | typeof OUTCOME_UNKNOWN;
  reservation: NonNullable<Admission["reservation"]>;
} {
  const code = admission.request?.errorCode;
  if (
    current.state !== "RUNNING" ||
    current.idempotencyKey !== claim.idempotencyKey ||
    current.providerJobId ||
    jobIdFromAdmission(admission) ||
    !protocol.safeParse(admission.request?.responseMetadata).success ||
    (code !== DISPATCHING && code !== OUTCOME_UNKNOWN) ||
    !admission.reservation ||
    !["RESERVED", "EXPIRED"].includes(admission.reservation.status)
  )
    throw new DispatchAdmissionError("Text dispatch claim changed");
  return { code, reservation: admission.reservation };
}

async function checkSend(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  code: string,
  reservation: { status: string; expiresAt: Date },
  check: () => Promise<void>,
): Promise<string | null> {
  if (
    code !== DISPATCHING ||
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
