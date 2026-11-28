import type { MediaReceipt } from "@reelforge/contracts";
import { z } from "zod";
import type { Scoped, Step, Transaction } from "../runs/runs.types.js";

export async function refusalBillDeltas(
  db: Scoped,
  runId: string,
): Promise<
  {
    sequence: number;
    amount: number;
  }[]
> {
  const events = await db.runEvent.findMany({
    where: { runId, type: "provider_receipt", payload: { path: ["refusedBilling"], equals: true } },
    select: { sequence: true, payload: true },
  });
  return events.map(({ sequence, payload }) => ({
    sequence,
    amount: z.object({ adjustmentMinor: z.int() }).parse(payload).adjustmentMinor,
  }));
}

export async function manifestHasBillingChange(db: Scoped, runId: string): Promise<boolean> {
  // The correction event also covers manifests written by older workers before
  // descriptors were explicitly withdrawn. A failed rebuild never acknowledges it.
  const latest = await db.runEvent.findFirst({
    where: {
      runId,
      OR: [
        { type: "assembly_receipts_checked" },
        { type: "provider_receipt", payload: { path: ["key"], string_starts_with: "shot-" } },
      ],
    },
    orderBy: { sequence: "desc" },
    select: { type: true },
  });
  return latest?.type === "provider_receipt";
}

// Pre-cutover manifests had gross lines and no linked credits. A total that cannot
// be explained by those lines gives no basis for a text delta.
export function rebuiltTotal(
  manifest: { receipts: MediaReceipt[]; totalCostMinor: number },
  receipts: MediaReceipt[],
): number | null {
  const original = manifest.receipts;
  const contribution = (receipt: MediaReceipt): number =>
    receipt.key.startsWith("media:text:")
      ? (receipt.postedNetMinor ?? receipt.costMinor)
      : receipt.costMinor;
  const archivedLines = original.reduce((sum, receipt) => sum + contribution(receipt), 0);
  let total = manifest.totalCostMinor;
  for (const [i, receipt] of receipts.entries()) {
    const old = original[i]!;
    const delta = contribution(receipt) - contribution(old);
    if (
      delta !== 0 &&
      old.key.startsWith("media:text:") &&
      old.postedNetMinor === undefined &&
      receipt.postedNetMinor !== undefined &&
      archivedLines !== manifest.totalCostMinor
    )
      return null;
    total += delta;
  }
  return total;
}

export async function writeRefusalCreditEvent(
  tx: Transaction,
  step: Step,
  adjustmentMinor: number,
): Promise<void> {
  const { workspaceId, runId } = step;
  const run = await tx.videoRun.update({
    where: { workspaceId, id: runId },
    data: { revision: { increment: 1 } },
    select: { correlationId: true, revision: true },
  });
  await tx.runEvent.create({
    data: {
      workspaceId,
      runId,
      stepId: step.id,
      correlationId: run.correlationId,
      sequence: run.revision,
      type: "provider_receipt",
      payload: { key: step.key, refusedBilling: true, adjustmentMinor },
    },
  });
}
