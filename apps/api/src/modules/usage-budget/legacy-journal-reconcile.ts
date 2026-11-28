import type { Run, Step, Transaction } from "../runs/runs.types.js";
import { auditedLegacyCredits, type LegacyCredits } from "./legacy-text-import-credits.js";
import type { Imported, LegacyTextImportOptions } from "./legacy-text-import.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { operatorContext } from "./text-attempt-ops.js";
import { appendTextEvidence, deriveTextAttempt } from "./text-attempt-store.js";
import { journalRejections, type Evidence } from "./text-journal-upgrade.js";

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
  const { pending } = journalRejections(step.idempotencyKey, rows);
  if (!projection)
    return {
      attemptId: step.id,
      action: "blocked",
      reason: "attempt already has evidence without projection",
      rejections: pending,
    };
  const credits = await auditedLegacyCredits(tx, step, run.channelId);
  if (!credits)
    return { attemptId: step.id, action: "blocked", reason: "conflicting legacy credit audit" };
  const before = {
    reservedMinor: projection.reservedMinor,
    grossMinor: projection.grossMinor,
    netMinor: projection.netMinor,
  };
  const bill = !pending.length && deriveTextAttempt(step.idempotencyKey, rows);
  const unpostedBill = bill && bill.actualMinor !== null && bill.netMinor > (step.costMinor ?? 0);
  if (!pending.length && !credits.links.length && !unpostedBill)
    return { attemptId: step.id, action: "already-imported", after: before };
  const proposed = await stageReconciliation(tx, step, rows, credits, pending, options);
  const state = options.apply
    ? await foldTextAttempt(tx, operatorContext(run.workspaceId), step.id)
    : deriveTextAttempt(step.idempotencyKey, proposed)!;
  return {
    attemptId: step.id,
    action: options.apply ? "reconciled" : "requires-reconciliation",
    before,
    after: {
      grossMinor: state.grossMinor,
      netMinor: state.netMinor,
      reservedMinor: state.reservedMinor,
    },
    rejections: pending,
    creditIds: credits.links.map((link) => link.adjustmentId),
  };
}

async function stageReconciliation(
  tx: Transaction,
  step: Step,
  rows: readonly Evidence[],
  credits: LegacyCredits,
  pending: ReturnType<typeof journalRejections>["pending"],
  options: LegacyTextImportOptions,
): Promise<Evidence[]> {
  const proposed = [...rows];
  const nonce = rows.find((row) => row.kind === "ARMED")?.nonce;
  const entry = {
    kind: "JOURNAL_REPAIR" as const,
    ...(nonce && { nonce }),
    eventKey: `upgrade:rejections:${pending.map((row) => row.sequence).join("-")}`,
    data: {
      dispatchKey: step.idempotencyKey,
      auditId: options.auditId ?? "dry-run",
      rejections: pending,
    },
  };
  if (pending.length) {
    proposed.push({ ...entry, sequence: proposed.length + 1, nonce: nonce ?? null });
    if (options.apply) await appendTextEvidence(tx, step, entry);
  }
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
