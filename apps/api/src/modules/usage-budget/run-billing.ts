import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { pinnedBudget } from "./run-envelope.js";
import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import {
  billingHold,
  SETTLED_SHOTS,
  clearResolvedSubmissionHold,
  failSettledGeneration,
} from "../runs/run-outcomes.js";
import type { Context, Json, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import {
  BILLING_OVERAGE,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  isBillingHold,
  readAdmission,
} from "./run-admission-state.js";
import type { RunPaidCalls } from "./run-paid.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

const pricedOutput = z.object({
  receipt: z.object({ providerJobId: z.string().min(1), costMinor: z.int().nonnegative() }),
});
export function awaitingBilling(step: Step): boolean {
  return isBillingHold(step.error);
}

async function holdPricedReceipt(
  db: Scoped,
  tx: Transaction,
  usage: UsageBudgetService,
  run: Run,
  step: Step,
  context: Context,
  output: Json,
): Promise<void> {
  const { receipt } = pricedOutput.parse(output);
  const claim = await readAdmission(tx, context, step);
  if (
    !claim.reservation ||
    step.state !== "WAITING_EXTERNAL" ||
    receipt.providerJobId !== step.providerJobId
  )
    throw new ConflictException("Billing receipt does not match the paid attempt");
  await usage.recordOverage(
    tx,
    run.workspaceId,
    run.channelId,
    claim.reservation.id,
    receipt.costMinor,
  );
  const saved = await tx.providerRequest.updateMany({
    where: {
      workspaceId: run.workspaceId,
      correlationId: step.id,
      errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN] },
    },
    data: {
      status: "SUCCEEDED",
      errorCode: BILLING_OVERAGE,
      actualCost: receipt.costMinor / 100,
      responseMetadata: { providerJobId: receipt.providerJobId, dispatched: true, costKnown: true },
    },
  });
  if (saved.count !== 1) throw new ConflictException("Billing claim changed");
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: { output, error: { code: BILLING_OVERAGE } },
  });
  await db.videoRun.updateMany({
    where: { id: run.id },
    data: { pauseReason: billingHold(step.id) },
  });
}

/** Recovery consumes the immutable receipt, never another poll, fetch or price lookup. */
export async function reconcilePricedReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
): Promise<void> {
  await store.mutate(context, step.runId, "billing_reconciled", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (current.state === "SUCCEEDED") return { value: null, payload: { replay: true } };
    const claim = await readAdmission(tx, context, current);
    const { receipt } = pricedOutput.parse(current.output);
    const cost = receipt.costMinor;
    if (
      claim.evidence !== "billing-overage" ||
      !awaitingBilling(current) ||
      current.state !== "WAITING_EXTERNAL" ||
      receipt.providerJobId !== current.providerJobId ||
      !claim.request?.actualCost?.mul(100).equals(cost)
    )
      throw new ConflictException("Stored billing evidence changed");
    await settleReceipt(db, tx, paid, context, run, current, cost, current.output as Json);
    const reserved = current.costMinor ?? 0;
    return { value: null, payload: { costMinor: cost, reservedMinor: reserved }, stepId: step.id };
  });
}

async function settleReceipt(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  cost: number,
  output: Json,
): Promise<void> {
  const reserved = step.costMinor ?? 0;
  await paid.commitJob(tx, context, step, cost);
  const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
  await db.budgetEnvelope.updateMany({
    where: { id: budget.id },
    data: {
      reservedMinor: budget.reservedMinor - reserved,
      spentMinor: budget.spentMinor + cost,
      overageMinor: budget.overageMinor + Math.max(0, cost - reserved),
      revision: budget.revision + 1,
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: {
      state: "SUCCEEDED",
      costMinor: cost,
      finishedAt: new Date(),
      output,
      error: Prisma.DbNull,
    },
  });
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  await failSettledGeneration(db, { ...run, pauseReason });
}

export async function recordShotReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  output: Json,
  pricedCost?: number,
): Promise<{ value: boolean; event: import("../runs/runs.types.js").Event }> {
  return store.mutate(context, step.runId, "step_completed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (SETTLED_SHOTS.some((state) => state === current.state) || awaitingBilling(current))
      return { value: false, payload: { replay: true } };
    if (
      current.state !== "WAITING_EXTERNAL" ||
      current.providerJobId !== step.providerJobId ||
      !current.providerJobId
    )
      throw new ConflictException("Provider job claim changed");
    const reserved = current.costMinor ?? 0;
    const cost = pricedCost ?? reserved;
    if (cost > reserved) {
      await holdPricedReceipt(db, tx, paid.usage, run, current, context, output);
      return {
        value: false,
        eventType: "reconcile_required",
        stepId: step.id,
        payload: { reason: billingHold(step.id), costMinor: cost },
      };
    }
    await settleReceipt(db, tx, paid, context, run, current, cost, output);
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    return {
      value: true,
      stepId: step.id,
      payload: { costMinor: cost, warn: budget.spentMinor > pinnedBudget(run).targetMinor },
    };
  });
}
