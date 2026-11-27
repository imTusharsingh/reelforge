import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { RunsService } from "../runs/runs.service.js";
import { json, type Context } from "../runs/runs.types.js";
import { appendTextEvidence, lockTextAttempt } from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { maybeCompleteTextCancellation } from "./text-attempt-cancel.js";

type SupervisorProof = {
  attemptId: string;
  incarnation: string;
  nonce: string;
  auditId: string;
};

/** Internal supervisor boundary. Invoke only from the process supervisor after
 * it verifies exit for this exact incarnation; a DB-session loss is not proof. */
export async function retireExitedTextSender(
  runs: RunsService,
  supervisor: Context,
  proof: SupervisorProof,
): Promise<void> {
  if (supervisor.role !== "OWNER" || !proof.auditId.trim())
    throw new ForbiddenException("Audited process-exit proof is required");
  const runId = await runs.store.db.$transaction(async (tx) => {
    const step = await lockTextAttempt(tx, supervisor.workspaceId, proof.attemptId);
    const arm = await tx.textAttemptEvidence.findFirst({
      where: {
        workspaceId: supervisor.workspaceId,
        attemptId: step.id,
        kind: "ARMED",
        nonce: proof.nonce,
        data: { path: ["incarnation"], equals: proof.incarnation },
      },
    });
    if (!arm) throw new ConflictException("Retirement does not match the authorized sender");
    await appendTextEvidence(tx, step, {
      kind: "SENDER_RETIRED",
      eventKey: `supervisor-exit:${proof.nonce}:${proof.auditId}`,
      nonce: proof.nonce,
      data: json({
        dispatchKey: step.idempotencyKey,
        incarnation: proof.incarnation,
        auditId: proof.auditId,
        recordedBy: supervisor.userId,
      }),
    });
    await foldTextAttempt(tx, supervisor, step.id);
    return step.runId;
  });
  await maybeCompleteTextCancellation(runs, supervisor, runId);
}
