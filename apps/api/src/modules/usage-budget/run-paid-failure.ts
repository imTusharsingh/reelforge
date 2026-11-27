import { terminalTextEligible, readAdmission } from "./run-admission-state.js";
import type { InvalidCompletedText } from "@reelforge/ai-providers";
import { readReceiptBudget } from "./run-shot-receipt.js";
import { failRunIfSettled as settleRunFailure } from "../runs/run-outcomes.js";
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
  const manual = reason === "OWNER_CONFIRMED_TERMINAL_TEXT";
  const result = await store.mutate(context, step.runId, "step_failed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({
      where: { id: step.id, runId: run.id },
    });
    if (!(await canFinalize(tx, context, current, step, reason, manual)))
      return { value: null, payload: { replay: true }, stepId: step.id };
    const amount = current.costMinor ?? 0;
    const cost = dispatched ? (readReceiptBudget(current.output)?.estimateMinor ?? amount) : 0;
    await paid.settleFailedRequest(
      tx,
      context,
      current,
      message,
      dispatched,
      cost,
      providerJobId,
      usage,
    );
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: {
        state: "FAILED",
        providerJobId,
        costMinor: cost,
        finishedAt: new Date(),
        error: { code: reason, message },
      },
    });
    await settleEnvelope(db, run, amount, cost);
    await failRunIfSettled(context, db, tx, run, current, { code: reason, message });
    return {
      value: null,
      payload: {
        reason,
        message,
        ...(manual
          ? { confirmedBy: context.userId, committedEstimateMinor: cost }
          : { releasedMinor: amount }),
      },
      stepId: step.id,
    };
  });
  return result.event;
}

async function canFinalize(
  tx: Transaction,
  context: Context,
  current: Step,
  step: Step,
  reason: string,
  manual: boolean,
): Promise<boolean> {
  if (
    current.state === "FAILED" &&
    (!manual ||
      (typeof current.error === "object" &&
        current.error &&
        "code" in current.error &&
        current.error.code === reason))
  )
    return false;
  if (
    current.state !== (step.providerJobId ? "WAITING_EXTERNAL" : "RUNNING") ||
    current.providerJobId !== step.providerJobId ||
    current.idempotencyKey !== step.idempotencyKey
  )
    throw new ConflictException("Dispatch claim changed");
  if (manual && !terminalTextEligible(current, await readAdmission(tx, context, current)))
    throw new ConflictException("Text attempt is not awaiting terminal confirmation");
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
  if (step.key.startsWith("media:text:critic:")) return settleRunFailure(db, tx, run, step, error);
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
  } else if (step.key.startsWith("media:text:") || step.key.startsWith("media:reference:")) {
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
        revision: budget.revision + 1,
      },
    });
}

export function finalizeInvalidText(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  receipt: InvalidCompletedText,
): Promise<Event> {
  return finalizeFailed(
    store,
    paid,
    context,
    step,
    "PROVIDER_INVALID_OUTPUT",
    "Provider completed the text call but returned invalid output",
    true,
    receipt.providerJobId,
    receipt.usage,
  );
}
