import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { RunsStore } from "../runs/runs.store.js";
import {
  RECOVERY_PRINCIPAL,
  type Context,
  type Database,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";
import { maybeCompleteTextCancellation } from "./text-attempt-cancel.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { lockTextAttempt } from "./text-attempt-store.js";
import type { TextAttemptOpsTarget } from "./text-attempt-ops-schema.js";

/** This is a database operator boundary, not a workspace-owner permission. */
export const operatorContext = (workspaceId: string): Context => ({
  workspaceId,
  userId: RECOVERY_PRINCIPAL,
  role: "OWNER",
});

export async function lockOperatorTarget(
  tx: Transaction,
  target: TextAttemptOpsTarget,
): Promise<{ step: Step; armData: unknown; armedAt: Date }> {
  const step = await lockTextAttempt(tx, target.workspaceId, target.attemptId);
  const arm = await tx.textAttemptEvidence.findFirst({
    where: {
      workspaceId: target.workspaceId,
      attemptId: step.id,
      kind: "ARMED",
      nonce: target.armNonce,
      AND: [
        { data: { path: ["incarnation"], equals: target.incarnation } },
        { data: { path: ["dispatchKey"], equals: target.dispatchKey } },
      ],
    },
  });
  if (!arm || step.idempotencyKey !== target.dispatchKey)
    throw new ConflictException("Operator evidence does not match the exact armed attempt");
  return { step, armData: arm.data, armedAt: arm.createdAt };
}

export function operatorEventKey(kind: string, source: string, reference: string): string {
  const auditHash = createHash("sha256")
    .update(JSON.stringify([source, reference]))
    .digest("hex");
  return `operator:${kind}:${auditHash}`;
}

export async function foldOperatorEvidence(
  db: Database,
  target: TextAttemptOpsTarget,
): Promise<void> {
  const context = operatorContext(target.workspaceId);
  const runId = await db.$transaction(async (tx) => {
    const { step } = await lockOperatorTarget(tx, target);
    await foldTextAttempt(tx, context, step.id);
    return step.runId;
  });
  await maybeCompleteTextCancellation({ store: new RunsStore(db), events: null }, context, runId);
}

export function validateAuditTime(observedAt: string, armedAt: Date): void {
  const observed = Date.parse(observedAt);
  if (observed < armedAt.getTime() || observed > Date.now())
    throw new ConflictException("Audit observation is outside the valid post-arm time range");
}
