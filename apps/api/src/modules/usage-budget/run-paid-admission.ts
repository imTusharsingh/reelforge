import {
  ADMISSION_ORDERING,
  canRollback,
  OUTCOME_UNKNOWN,
  readAdmission,
} from "./run-admission-state.js";
import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { clearResolvedSubmissionHold, submissionHold } from "../runs/run-outcomes.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

export class SubmissionOutcomeUnknown extends ConflictException {}

export async function rollbackAdmission(
  store: RunsStore,
  usage: Pick<UsageBudgetService, "release">,
  context: Context,
  step: Step,
  budgetDenied = false,
): Promise<void> {
  const result = await store.mutate(
    context,
    step.runId,
    "dispatch_released",
    async (db, run, tx) => {
      const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      const unchanged =
        current.idempotencyKey === step.idempotencyKey &&
        current.state === "RUNNING" &&
        !current.providerJobId;
      if (!unchanged) return { value: null, payload: { replay: true } };
      const admission = await readAdmission(tx, context.workspaceId, current);
      if (admission.evidence === "ambiguous")
        return holdAmbiguousAdmission(db, tx, run, current, admission.request !== null);
      if (!canRollback(admission)) return { value: null, payload: { replay: true } };
      const amount = await releaseAdmission(
        db,
        tx,
        usage,
        context,
        run,
        current,
        admission.reservation?.id,
        budgetDenied && admission.evidence === "never-dispatched",
      );
      return {
        value: null,
        payload: { amountMinor: amount, reason: "NOT_DISPATCHED" },
        stepId: step.id,
      };
    },
  );
  if (result.value) throw new SubmissionOutcomeUnknown(result.value);
}

async function releaseAdmission(
  db: Scoped,
  tx: Transaction,
  usage: Pick<UsageBudgetService, "release">,
  context: Context,
  run: Run,
  step: Step,
  reservationId: string | undefined,
  budgetDenied: boolean,
): Promise<number> {
  const where = { workspaceId: context.workspaceId, correlationId: step.id };
  const shot = step.key.startsWith("shot-");
  if (reservationId) await releaseReservation(tx, usage, context, reservationId);
  await tx.providerRequest.updateMany({
    where: { ...where, errorCode: "PENDING" },
    data: {
      errorCode: shot ? "ADMISSION_ROLLED_BACK" : "NOT_DISPATCHED",
      actualCost: 0,
      responseMetadata: {
        admissionOrdering: ADMISSION_ORDERING,
        dispatched: false,
        costKnown: true,
      },
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: shot
      ? {
          state: "PENDING",
          costMinor: null,
          providerId: null,
          startedAt: null,
          idempotencyKey: `${step.id}:admission:${randomUUID()}`,
        }
      : {
          state: "CANCELLED",
          finishedAt: new Date(),
          ...(budgetDenied ? {} : { output: { closedBy: "NOT_DISPATCHED" } }),
        },
  });
  const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
  const amount = step.costMinor ?? 0;
  if (budget && amount)
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: { reservedMinor: budget.reservedMinor - amount, revision: budget.revision + 1 },
    });
  await clearResolvedSubmissionHold(db, tx, run, step.id);
  return amount;
}

async function holdAmbiguousAdmission(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  hasRequest: boolean,
): Promise<{ value: string; payload: { reason: string }; stepId: string; eventType: string }> {
  const reason = submissionHold(step.id);
  const where = { workspaceId: run.workspaceId, correlationId: step.id };
  if (hasRequest)
    await tx.providerRequest.update({
      where: { workspaceId_correlationId: where },
      data: { errorCode: OUTCOME_UNKNOWN },
    });
  else
    // Persist the hold in the ledger so cancel and sibling settlement also respect it.
    await tx.providerRequest.create({
      data: {
        ...where,
        channelId: run.channelId,
        providerId: step.providerId ?? "unconfigured",
        capabilityId: "video",
        status: "FAILED",
        errorCode: OUTCOME_UNKNOWN,
      },
    });
  if (!run.pauseReason?.startsWith("RECONCILE_REQUIRED"))
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: reason } });
  return { value: reason, payload: { reason }, stepId: step.id, eventType: "reconcile_required" };
}

async function releaseReservation(
  tx: Transaction,
  usage: Pick<UsageBudgetService, "release">,
  context: Context,
  reservationId: string,
): Promise<void> {
  await usage.release(context.workspaceId, reservationId, "NOT_DISPATCHED", tx);
  // Keep the released reservation while freeing the unique current-attempt correlation.
  await tx.usageReservation.update({
    where: { id: reservationId },
    data: { correlationId: null },
  });
}
