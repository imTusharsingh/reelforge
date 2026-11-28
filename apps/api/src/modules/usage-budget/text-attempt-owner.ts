import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { RunsService } from "../runs/runs.service.js";
import { json, type Context, type Step, type Transaction } from "../runs/runs.types.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { hasPendingTextOutcome } from "./text-attempt-delivery.js";
import { foldTextAttempt } from "./text-attempt-fold.js";

export async function canOwnerConfirmText(
  tx: Transaction,
  step: Step,
  context: Context,
  artifacts: RunsService["artifacts"],
): Promise<boolean> {
  const evidence = await readTextAttempt(tx, step);
  return (
    !!evidence &&
    evidence.positiveSent &&
    evidence.senderRetired &&
    evidence.phase === "SENT" &&
    !evidence.ownerConfirmed &&
    evidence.output === null &&
    evidence.armNonce !== null &&
    !(await hasPendingTextOutcome(artifacts, context, step, evidence.armNonce))
  );
}

export async function confirmTextAttempt(
  runs: RunsService,
  context: Context,
  runId: string,
  stepId: string,
): Promise<void> {
  if (context.role !== "OWNER") throw new ForbiddenException("Workspace owner required");
  if (process.env.PAID_TEXT_V3_ENABLED !== "1")
    throw new ConflictException("Paid text reconciliation is disabled");
  const result = await runs.store
    .mutate(context, runId, "text_owner_confirmed", async (db, run, tx) => {
      if (
        !(await db.videoRunStep.findFirst({
          where: { id: stepId, runId: run.id, key: { startsWith: "media:text:" } },
          select: { id: true },
        }))
      )
        throw new ConflictException("Unknown text attempt");
      const step = await lockTextAttempt(tx, context.workspaceId, stepId);
      if (step.runId !== run.id) throw new ConflictException("Unknown text attempt");
      const replay = await tx.textAttemptEvidence.findFirst({
        where: { workspaceId: context.workspaceId, attemptId: step.id, kind: "OWNER_CONFIRMED" },
      });
      if (replay) throw new ConfirmationReplay();
      if (!(await canOwnerConfirmText(tx, step, context, runs.artifacts)))
        throw new ConflictException("Text attempt is not awaiting terminal confirmation");
      await appendTextEvidence(tx, step, {
        kind: "OWNER_CONFIRMED",
        eventKey: "owner-confirmation",
        data: json({ dispatchKey: step.idempotencyKey, confirmedBy: context.userId }),
      });
      await foldTextAttempt(tx, context, step.id);
      return { value: null, payload: { confirmedBy: context.userId }, stepId };
    })
    .catch((error: unknown) => {
      if (error instanceof ConfirmationReplay) return null;
      throw error;
    });
  if (result) await runs.events?.publish(result.event);
}

class ConfirmationReplay extends Error {}
