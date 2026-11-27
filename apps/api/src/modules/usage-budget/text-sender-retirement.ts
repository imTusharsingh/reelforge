import { isDeepStrictEqual } from "node:util";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { json, type Database } from "../runs/runs.types.js";
import { appendTextEvidence } from "./text-attempt-store.js";
import {
  proveLocalTextSenderExit,
  textSenderIdentity,
  type TextSenderIdentity,
} from "./text-sender-identity.js";
import { textSenderRetirementProof } from "./text-attempt-ops-schema.js";
import {
  foldOperatorEvidence,
  lockOperatorTarget,
  operatorEventKey,
  validateAuditTime,
} from "./text-attempt-ops.js";

const storedSender = z.object({ sender: textSenderIdentity });
type ExitProof = z.infer<typeof textSenderRetirementProof>;

/** DB-privileged input: the operator must independently authenticate external audit records. */
export async function retireExitedTextSender(db: Database, input: unknown): Promise<void> {
  const proof = textSenderRetirementProof.parse(input);
  const { target, source, actor, reference } = proof;
  const eventKey = operatorEventKey("exit", source, reference);
  await db.$transaction(async (tx) => {
    const { step, armData, armedAt } = await lockOperatorTarget(tx, target);
    const { sender } = storedSender.parse(armData);
    if (sender.incarnation !== target.incarnation)
      throw new ConflictException("Stored sender does not match the armed incarnation");
    const immutable = { dispatchKey: target.dispatchKey, sender, actor, reference, source };
    const prior = await tx.textAttemptEvidence.findFirst({
      where: { workspaceId: target.workspaceId, attemptId: target.attemptId, eventKey },
    });
    const data = proofData(proof, sender, armedAt, prior?.data);
    await appendTextEvidence(tx, step, {
      kind: "SENDER_RETIRED",
      nonce: target.armNonce,
      eventKey,
      data: json({ ...immutable, ...data }),
    });
  });
  await foldOperatorEvidence(db, target);
}

const localExit = z.object({
  observedAt: z.iso.datetime(),
  result: z.enum(["absent", "exited", "pid-reused"]),
});

function proofData(
  proof: ExitProof,
  sender: TextSenderIdentity,
  armedAt: Date,
  prior: unknown,
): {
  observedAt: string;
  result: "absent" | "exited" | "pid-reused" | "process-exited";
} {
  if (proof.source === "local-procfs") {
    if (prior) return localExit.parse(prior); // Exact replay with the original observation.
    const { result, checkedAt: observedAt } = proveLocalTextSenderExit(sender);
    return { observedAt, result };
  }
  if (!isDeepStrictEqual(sender, proof.sender))
    throw new ConflictException("Terminal supervisor record does not match the stored sender");
  validateAuditTime(proof.observedAt, armedAt);
  return { observedAt: proof.observedAt, result: proof.result };
}
