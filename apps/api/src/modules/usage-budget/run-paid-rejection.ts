import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import { json } from "../runs/runs.types.js";
import {
  attachedTextResult,
  canConfirmRejection,
  DISPATCHING,
  jobIdFromAdmission,
  OUTCOME_UNKNOWN,
  readAdmission,
} from "./run-admission-state.js";
import { retainedOwnerEvidence } from "./text-evidence.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

type Failure = {
  message: string;
  dispatched: boolean;
  cost: number;
  providerJobId: string | null;
  usage?: Record<string, unknown>;
};
export async function settleFailedRequest(
  ledger: Pick<UsageBudgetService, "commit" | "release">,
  tx: Transaction,
  context: Context,
  step: Step,
  { message, dispatched, cost, providerJobId, usage }: Failure,
): Promise<void> {
  const text = step.key.startsWith("media:text:");
  if (!dispatched) await assertZeroCostRejection(tx, context, step, text);
  const code =
    usage !== undefined
      ? "PROVIDER_INVALID_OUTPUT"
      : dispatched
        ? "PROVIDER_JOB_FAILED"
        : "NOT_DISPATCHED";
  const updated = await tx.providerRequest.updateMany({
    where: {
      workspaceId: context.workspaceId,
      correlationId: step.id,
      errorCode: dispatched || text ? { in: [DISPATCHING, OUTCOME_UNKNOWN] } : DISPATCHING,
    },
    data: {
      status: "FAILED",
      actualCost: dispatched ? null : 0,
      ...(usage !== undefined ? { usage: json(usage) } : {}),
      responseMetadata: {
        ...(await retainedOwnerEvidence(tx, context, step)),
        dispatched,
        costKnown: !dispatched,
        ...(step.key.startsWith("media:text:") && {
          dispatchKey: step.idempotencyKey,
          costBasis: "RESERVATION",
        }),
        ...(providerJobId && providerJobId !== step.idempotencyKey ? { providerJobId } : {}),
      },
      errorCode: code,
      errorMessage: message,
    },
  });
  if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
  const reservation = await tx.usageReservation.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
  });
  if (dispatched) await ledger.commit(context.workspaceId, reservation.id, cost, tx);
  else await ledger.release(context.workspaceId, reservation.id, code, tx);
}

export const OWNER_TERMINAL_TEXT = "OWNER_CONFIRMED_TERMINAL_TEXT";
const stepError = z.object({ code: z.string() });

/** Correct the original commitment, never reopen the run or create another attempt. */
export async function reconcileOwnerEstimate(
  db: Scoped,
  tx: Transaction,
  context: Context,
  run: Run,
  step: Step,
  error: { code: string; message: string },
): Promise<{
  value: null;
  eventType: string;
  stepId: string;
  payload: ReturnType<typeof json>;
} | null> {
  if (
    step.state !== "FAILED" ||
    !step.key.startsWith("media:text:") ||
    stepError.safeParse(step.error).data?.code !== OWNER_TERMINAL_TEXT
  )
    return null;
  const admission = await readAdmission(tx, context, step);
  const { request, reservation } = admission;
  const original = step.costMinor ?? 0;
  if (
    !request ||
    request.errorCode !== "PROVIDER_JOB_FAILED" ||
    request.actualCost !== null ||
    request.usage !== null ||
    jobIdFromAdmission(admission) ||
    step.providerJobId ||
    attachedTextResult(step) ||
    reservation?.status !== "COMMITTED" ||
    reservation.committedMinor !== BigInt(original)
  )
    throw new ConflictException("Conflicting evidence for a settled text attempt");
  await correctRejectedCharge(db, tx, context, step, {
    runId: run.id,
    requestId: request.id,
    reservationId: reservation.id,
    original,
    error,
  });
  return {
    value: null,
    eventType: "text_rejection_reconciled",
    stepId: step.id,
    payload: {
      dispatchKey: step.idempotencyKey,
      previousEstimateMinor: original,
      actualMinor: 0,
      reason: error.code,
    },
  };
}

async function correctRejectedCharge(
  db: Scoped,
  tx: Transaction,
  context: Context,
  step: Step,
  {
    runId,
    requestId,
    reservationId,
    original,
    error,
  }: {
    runId: string;
    requestId: string;
    reservationId: string;
    original: number;
    error: { code: string; message: string };
  },
): Promise<void> {
  await tx.usageReservation.update({
    where: { id: reservationId },
    data: { committedMinor: 0n },
  });
  await tx.providerRequest.update({
    where: { id: requestId },
    data: {
      errorCode: "NOT_DISPATCHED",
      errorMessage: error.message,
      actualCost: 0,
      responseMetadata: {
        ...(await retainedOwnerEvidence(tx, context, step)),
        dispatchKey: step.idempotencyKey,
        dispatched: false,
        costKnown: true,
        correctedOwnerEstimateMinor: original,
      },
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: { costMinor: 0, error },
  });
  const budget = await db.budgetEnvelope.findFirst({ where: { runId } });
  if (budget)
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: { spentMinor: budget.spentMinor - original, revision: budget.revision + 1 },
    });
}

async function assertZeroCostRejection(
  tx: Transaction,
  context: Context,
  step: Step,
  text: boolean,
): Promise<void> {
  const admission = await readAdmission(tx, context, step);
  if (canConfirmRejection(admission)) return;
  const { request, reservation } = admission;
  if (
    text &&
    request?.errorCode === OUTCOME_UNKNOWN &&
    request.usage === null &&
    request.actualCost === null &&
    !jobIdFromAdmission(admission) &&
    !attachedTextResult(step) &&
    reservation &&
    ["RESERVED", "EXPIRED"].includes(reservation.status)
  )
    return;
  throw new ConflictException("Paid dispatch outcome changed");
}
