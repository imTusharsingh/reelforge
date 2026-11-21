import { refusalRewrite } from "../orchestration/video-run.refusal.js";
import { canRollback, readAdmissions } from "../usage-budget/run-admission-state.js";
import { submissionHold } from "./run-outcomes.js";
import type { Context, Scoped, Step, Transaction } from "./runs.types.js";

export async function closeSteps(
  context: Context,
  db: Scoped,
  tx: Transaction,
  runId: string,
  steps: Step[],
  reason: "RUN_CANCELED" | "GENERATION_FAILED",
): Promise<string | null> {
  const admissions = await readAdmissions(db, tx, context.workspaceId, steps);
  await releaseSteps(
    context,
    db,
    tx,
    runId,
    admissions.filter(canRollback).map(({ step }) => step),
    reason,
  );
  const protectedAttempt = admissions.find((admission) => !canRollback(admission));
  return protectedAttempt ? submissionHold(protectedAttempt.step.id) : null;
}

export async function releaseSteps(
  context: Context,
  db: Scoped,
  tx: Transaction,
  runId: string,
  steps: Step[],
  reason: "RUN_CANCELED" | "OPERATOR_ABANDONED" | "GENERATION_FAILED",
): Promise<void> {
  const ids = steps.map((step) => step.id);
  await tx.usageReservation.updateMany({
    where: {
      workspaceId: context.workspaceId,
      idempotencyKey: { in: steps.map((step) => `m08:${step.idempotencyKey}`) },
      status: "RESERVED",
    },
    data: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason },
  });
  await tx.providerRequest.updateMany({
    where: {
      workspaceId: context.workspaceId,
      correlationId: { in: ids },
      status: "FAILED",
      actualCost: null,
    },
    data: {
      errorCode: reason,
      actualCost: 0,
      responseMetadata: { dispatched: false, costKnown: true },
    },
  });
  await db.videoRunStep.updateMany({
    where: { runId, id: { in: ids } },
    data: { state: "CANCELLED", finishedAt: new Date(), output: { closedBy: reason } },
  });
  for (const step of steps) {
    const rewrite = refusalRewrite(step);
    if (rewrite)
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: { output: { closedBy: reason, refusalRewrite: rewrite } },
      });
  }
  const refunded = steps
    .filter((step) => step.state === "RUNNING")
    .reduce((sum, step) => sum + (step.costMinor ?? 0), 0);
  if (!refunded) return;
  const budget = await db.budgetEnvelope.findFirst({ where: { runId } });
  if (budget) {
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: {
        reservedMinor: Math.max(0, budget.reservedMinor - refunded),
        revision: budget.revision + 1,
      },
    });
  }
}
