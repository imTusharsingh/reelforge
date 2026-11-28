import type { Run, Step, Transaction } from "../runs/runs.types.js";
import { auditedLegacyCredits, type LegacyCredits } from "./legacy-text-import-credits.js";
import type { Imported, LegacyTextImportOptions } from "./legacy-text-import.js";
import { appendTextEvidence, deriveTextAttempt, type Evidence } from "./text-attempt-store.js";

export async function reconcileExisting(
  tx: Transaction,
  run: Run,
  step: Step,
  options: LegacyTextImportOptions,
): Promise<Imported | undefined> {
  const where = { workspaceId: step.workspaceId, attemptId: step.id };
  const projection = await tx.textAttemptProjection.findUnique({
    where: { workspaceId_attemptId: where },
  });
  const rows = await tx.textAttemptEvidence.findMany({ where, orderBy: { sequence: "asc" } });
  if (!rows.length && !projection) return;
  if (!projection)
    return {
      attemptId: step.id,
      action: "blocked",
      reason: "attempt already has evidence without projection",
    };
  const credits = await auditedLegacyCredits(tx, step, run.channelId);
  if (!credits)
    return { attemptId: step.id, action: "blocked", reason: "conflicting legacy credit audit" };
  const before = {
    reservedMinor: projection.reservedMinor,
    grossMinor: projection.grossMinor,
    netMinor: projection.netMinor,
  };
  const current = deriveTextAttempt(step.idempotencyKey, rows);
  if (!current)
    return { attemptId: step.id, action: "blocked", reason: "projection lacks evidence" };
  if (
    !credits.links.length &&
    current.appliedSequence === projection.appliedSequence &&
    current.reservedMinor === projection.reservedMinor &&
    current.grossMinor === projection.grossMinor &&
    current.netMinor === projection.netMinor
  )
    return { attemptId: step.id, action: "already-imported", after: before };
  const proposed = await stageReconciliation(tx, step, rows, credits, options);
  const state = deriveTextAttempt(step.idempotencyKey, proposed)!;
  return {
    attemptId: step.id,
    action: options.apply ? "reconciled" : "requires-reconciliation",
    before,
    after: {
      grossMinor: state.grossMinor,
      netMinor: state.netMinor,
      reservedMinor: state.reservedMinor,
    },
    creditIds: credits.links.map((link) => link.adjustmentId),
  };
}

async function stageReconciliation(
  tx: Transaction,
  step: Step,
  rows: readonly Evidence[],
  credits: LegacyCredits,
  options: LegacyTextImportOptions,
): Promise<Evidence[]> {
  const proposed = [...rows];
  for (const { adjustmentId, operationKey } of credits.links) {
    const row = credits.rows.find((credit) => credit.id === adjustmentId)!;
    const event = {
      kind: "CREDIT" as const,
      eventKey: `credit:${adjustmentId}`,
      data: {
        adjustmentId,
        amountMinor: Number(row.amountMinor),
        auditId: options.auditId ?? "dry-run",
      },
    };
    proposed.push({ ...event, nonce: null, sequence: proposed.length + 1 });
    if (options.apply) {
      await tx.usageAdjustment.update({
        where: { id: adjustmentId },
        data: { textAttemptId: step.id, operationKey },
      });
      await appendTextEvidence(tx, step, event);
    }
  }
  return proposed;
}
