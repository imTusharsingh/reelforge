import { lockVideoJob } from "./video-job-evidence.js";
import { hasVideoDelivery } from "./run-video-terminal.js";
import { carryRefusalBill } from "./run-pending-receipt.js";
import { readReceiptBudget } from "./run-shot-receipt.js";
import { closeSteps } from "../runs/run-close-steps.js";
import { refusalRewrite } from "../orchestration/video-run.refusal.js";
import { ConflictException } from "@nestjs/common";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Step, Transaction, Event } from "../runs/runs.types.js";
import type { RunPaidCalls } from "./run-paid.js";
import {
  PLANNING_MANIFEST_KEY,
  referenceMediaPrefix,
  failSettledGeneration,
  clearResolvedSubmissionHold,
} from "../runs/run-outcomes.js";

class ReplayedFailure extends Error {
  constructor(readonly event: Event) {
    super();
  }
}

export async function finalizeFailed(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  reason: string,
  message: string,
  dispatched: boolean,
  providerJobId: string | null = step.providerJobId,
  usage?: Record<string, unknown>,
): Promise<Event> {
  return failureEvent(
    store.mutate(context, step.runId, "step_failed", async (db, run, tx) => {
      const current = step.key.startsWith("shot-")
        ? await lockVideoJob(tx, db, run, step.id)
        : await currentStep(db, run, step);
      if (current.key.startsWith("media:text:"))
        throw new ConflictException("Text failure requires its evidence journal");
      if (current.key.startsWith("shot-") && hasVideoDelivery(current))
        return { value: null, eventType: "step_failure_ignored", payload: { replay: true } };
      if (!canFinalize(current, step)) throw new ReplayedFailure(await previousFailure(db, step));
      const amount = current.costMinor ?? 0;
      const cost = await paid.settleFailedRequest(
        tx,
        context,
        current,
        message,
        dispatched,
        dispatched ? (readReceiptBudget(current.output)?.estimateMinor ?? amount) : 0,
        providerJobId,
        usage,
      );
      await markStepFailed(db, current, providerJobId, cost, { code: reason, message });
      await settleEnvelope(db, run, amount, cost);
      await failRunIfSettled(context, db, tx, run, current, { code: reason, message });
      return {
        value: null,
        payload: {
          reason,
          message,
          releasedMinor: amount,
        },
        stepId: step.id,
      };
    }),
  );
}

async function failureEvent(result: Promise<{ event: Event }>): Promise<Event> {
  try {
    return (await result).event;
  } catch (error) {
    if (error instanceof ReplayedFailure) return error.event;
    throw error;
  }
}

async function markStepFailed(
  db: Scoped,
  step: Step,
  providerJobId: string | null,
  cost: number,
  error: { code: string; message: string },
): Promise<void> {
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: {
      ...(error.code === "PROVIDER_FAILED" &&
        step.key.startsWith("shot-") &&
        carryRefusalBill(step)),
      state: "FAILED",
      providerJobId,
      costMinor: cost,
      finishedAt: new Date(),
      error,
    },
  });
}

async function previousFailure(db: Scoped, step: Step): Promise<Event> {
  return db.runEvent.findFirstOrThrow({
    where: { runId: step.runId, stepId: step.id, type: "step_failed" },
    orderBy: { sequence: "asc" },
  });
}

function canFinalize(current: Step, step: Step): boolean {
  if (current.state === "FAILED") return false;
  const waiting = step.providerJobId !== null;
  if (
    current.state !== (waiting ? "WAITING_EXTERNAL" : "RUNNING") ||
    current.providerJobId !== step.providerJobId ||
    current.idempotencyKey !== step.idempotencyKey
  )
    throw new ConflictException("Dispatch claim changed");
  return true;
}
async function failRunIfSettled(
  context: Context,
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: Step,
  error: { code: string; message: string },
): Promise<void> {
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  if (
    run.state === "CANCELED" ||
    (run.state === "FAILED" && step.key.startsWith(referenceMediaPrefix))
  )
    return;
  const frame = /^media:keyframe:(\d+):v(\d+)$/.exec(step.key);
  if (frame || (step.key.startsWith("shot-") && refusalRewrite(step))) {
    // A keyframe is bought before its owning shot can claim a video reservation.
    const owner = frame
      ? await db.videoRunStep.findFirst({
          where: {
            runId: run.id,
            key: `shot-${frame[1]}`,
            state: "PENDING",
            input: { path: ["version"], equals: Number(frame[2]) },
          },
          orderBy: { attempt: "desc" },
        })
      : step;
    if (owner) {
      await closeGeneration(context, db, tx, { ...run, pauseReason }, owner, {
        ...error,
        ...(frame ? { inputStepId: step.id } : {}),
      });
      return;
    }
  }
  if (step.key.startsWith("shot-") || frame) {
    await failSettledGeneration(db, { ...run, pauseReason });
  } else if (step.key.startsWith("media:reference:")) {
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
}

async function closeGeneration(
  context: Context,
  db: Scoped,
  tx: Transaction,
  run: Run,
  owner: Step,
  error: { code: string; message: string; inputStepId?: string },
): Promise<void> {
  await db.videoRunStep.updateMany({
    where: { id: owner.id },
    data: {
      state: "FAILED",
      finishedAt: new Date(),
      error: {
        ...error,
        closesGeneration: true,
      },
    },
  });
  const undispatched = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      providerJobId: null,
      state: { in: ["PENDING", "RUNNING"] },
      OR: [{ key: { startsWith: "shot-" } }, { key: { startsWith: "media:keyframe:" } }],
    },
  });
  const hold = await closeSteps(context, db, tx, run, undispatched, "GENERATION_FAILED");
  const draining = {
    state: "NEEDS_HUMAN" as const,
    pauseReason:
      hold ?? (run.pauseReason?.startsWith("RECONCILE_REQUIRED") ? run.pauseReason : error.code),
    ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" as const } : {}),
  };
  await db.videoRun.updateMany({ where: { id: run.id }, data: draining });
  await failSettledGeneration(db, { ...run, ...draining });
}

async function settleEnvelope(db: Scoped, run: Run, amount: number, cost: number): Promise<void> {
  const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
  if (budget)
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: {
        reservedMinor: budget.reservedMinor - amount,
        spentMinor: budget.spentMinor + cost,
        overageMinor: Math.max(
          budget.overageMinor,
          budget.spentMinor + cost + budget.reservedMinor - amount - budget.hardCapMinor,
        ),
        revision: budget.revision + 1,
      },
    });
}

function currentStep(db: Scoped, run: Run, step: Step): Promise<Step> {
  return db.videoRunStep.findFirstOrThrow({ where: { id: step.id, runId: run.id } });
}
