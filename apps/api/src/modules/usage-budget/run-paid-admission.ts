import {
  ADMISSION_ORDERING,
  type Admission,
  canRollback,
  OUTCOME_UNKNOWN,
  readAdmission,
} from "./run-admission-state.js";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { minorUnitExponent } from "./usage-budget.money.js";
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
      const admission = await readAdmission(tx, context, current);
      if (admission.evidence === "ambiguous")
        return holdAmbiguousAdmission(db, tx, run, current, admission);
      if (admission.evidence === "released-nondispatch") {
        await closeReleasedMedia(db, run, current);
        await clearResolvedSubmissionHold(db, tx, run, current.id);
        return { value: null, payload: { closedBy: "PROVIDER_NOT_DISPATCHED" }, stepId: step.id };
      }
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
        stepId: step.id,
        idempotencyKey: step.idempotencyKey,
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
  admission: Admission,
): Promise<{ value: string; payload: { reason: string }; stepId: string; eventType: string }> {
  const reason = submissionHold(step.id);
  const where = { workspaceId: run.workspaceId, correlationId: step.id };
  if (admission.request)
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
        ...unknownPrice(admission, step),
      },
    });
  if (!run.pauseReason?.startsWith("RECONCILE_REQUIRED"))
    await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: reason } });
  return { value: reason, payload: { reason }, stepId: step.id, eventType: "reconcile_required" };
}

function unknownPrice(
  { reservation }: Admission,
  step: Step,
): Pick<Prisma.ProviderRequestCreateManyInput, "estimatedCost" | "currency" | "createdAt"> {
  if (!reservation)
    return {
      estimatedCost: step.costMinor == null ? null : step.costMinor / 100,
      currency: "USD",
      createdAt: step.startedAt ?? step.createdAt,
    };
  return {
    estimatedCost: new Prisma.Decimal(reservation.amountMinor.toString()).div(
      new Prisma.Decimal(10).pow(minorUnitExponent(reservation.currency)),
    ),
    currency: reservation.currency,
    createdAt: reservation.createdAt,
  };
}

/** The provider and M18 already closed their halves of this legacy media claim. */
export async function closeReleasedMedia(db: Scoped, run: Run, step: Step): Promise<void> {
  const closed = await db.videoRunStep.updateMany({
    where: { id: step.id, runId: run.id, state: "RUNNING", providerJobId: null },
    data: {
      state: "CANCELLED",
      finishedAt: new Date(),
      output: { closedBy: "PROVIDER_NOT_DISPATCHED" },
    },
  });
  if (!closed.count || !step.costMinor) return;
  const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
  if (!budget) return;
  const siblings = await db.videoRunStep.aggregate({
    where: { runId: run.id, id: { not: step.id }, state: { in: ["RUNNING", "WAITING_EXTERNAL"] } },
    _sum: { costMinor: true },
  });
  const outstanding = Math.max(0, budget.reservedMinor - (siblings._sum.costMinor ?? 0));
  const refund = Math.min(step.costMinor, outstanding);
  if (refund)
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: { reservedMinor: budget.reservedMinor - refund, revision: budget.revision + 1 },
    });
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

export async function recordReservation(
  db: Transaction,
  context: Context,
  run: Run,
  step: Step,
  amount: number,
  createdAt: Date,
  rolledBackId: string | undefined,
): Promise<void> {
  const request = {
    providerId: step.providerId ?? "v3-stub",
    capabilityId: "video",
    status: "FAILED" as const,
    estimatedCost: amount / 100,
    actualCost: null,
    currency: "USD",
    responseMetadata: {
      admissionOrdering: ADMISSION_ORDERING,
      dispatched: false,
      costKnown: false,
    },
    errorCode: "PENDING",
  };
  const where = { workspaceId: context.workspaceId, correlationId: step.id };
  if (rolledBackId) {
    // Archive by the immutable request UUID. The rollback metadata retains the step and logical key.
    await db.providerRequest.update({
      where: { workspaceId_correlationId: where, errorCode: "ADMISSION_ROLLED_BACK" },
      data: { correlationId: rolledBackId },
    });
  }
  await db.providerRequest.create({
    data: { ...where, channelId: run.channelId, createdAt, ...request },
  });
}
