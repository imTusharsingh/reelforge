import { ConflictException } from "@nestjs/common";
import { isDefinitiveProviderRejection } from "@reelforge/ai-providers";
import { json, type Database } from "../runs/runs.types.js";
import { appendTextEvidence, readTextAttempt } from "./text-attempt-store.js";
import {
  matchedTextReceipt,
  matchedTextRejection,
  type TextAttemptOpsTarget,
} from "./text-attempt-ops-schema.js";
import {
  foldOperatorEvidence,
  lockOperatorTarget,
  operatorEventKey,
  validateAuditTime,
} from "./text-attempt-ops.js";

type ProviderAudit = {
  target: TextAttemptOpsTarget;
  source: string;
  reference: string;
  actor: string;
  observedAt: string;
};

function auditData({ target, source, reference, actor, observedAt }: ProviderAudit): {
  source: string;
  reference: string;
  actor: string;
  observedAt: string;
  incarnation: string;
} {
  return { source, reference, actor, observedAt, incarnation: target.incarnation };
}

async function ingestProviderEvidence(
  db: Database,
  proof: ProviderAudit,
  kind: "RECOVERED_RECEIPT" | "REJECTED",
  data: Record<string, unknown>,
  currency?: string,
): Promise<void> {
  const { target, source, reference, observedAt } = proof;
  await db.$transaction(async (tx) => {
    const { step, armedAt } = await lockOperatorTarget(tx, target);
    validateAuditTime(observedAt, armedAt);
    const state = await readTextAttempt(tx, step);
    if (!state?.senderRetired)
      throw new ConflictException("Verify sender retirement before importing provider evidence");
    if (currency !== undefined && currency !== state.currency)
      throw new ConflictException("Verified amount must be stated in the armed attempt currency");
    await appendTextEvidence(tx, step, {
      kind,
      nonce: target.armNonce,
      eventKey: operatorEventKey("provider", source, reference),
      data: json({ ...data, dispatchKey: target.dispatchKey, source: "matched-provider" }),
    });
  });
  await foldOperatorEvidence(db, target);
}

/** A verified provider receipt proves send, not a usable generated result. Never calls Google. */
export async function ingestMatchedTextReceipt(db: Database, input: unknown): Promise<void> {
  const proof = matchedTextReceipt.parse(input);
  const { target, googleId, usage, actualMinor, currency } = proof;
  if (googleId === target.dispatchKey)
    throw new ConflictException("Google ID and dispatch key must be distinct");
  if ((actualMinor !== undefined) !== (currency !== undefined))
    throw new ConflictException("Verified amount and currency must be provided together");
  await ingestProviderEvidence(
    db,
    proof,
    "RECOVERED_RECEIPT",
    {
      googleId,
      ...(usage !== undefined && { usage }),
      ...(actualMinor !== undefined && { actualMinor }),
      audit: { ...auditData(proof), currency: currency ?? null },
    },
    currency,
  );
}

/** Only accept the same authenticated deterministic status/code pairs as the live transport. */
export async function ingestMatchedTextRejection(db: Database, input: unknown): Promise<void> {
  const proof = matchedTextRejection.parse(input);
  const { code, httpStatus } = proof;
  if (!isDefinitiveProviderRejection(httpStatus, code))
    throw new ConflictException("Provider status and code do not prove deterministic rejection");
  await ingestProviderEvidence(db, proof, "REJECTED", {
    code,
    httpStatus,
    audit: auditData(proof),
  });
}
