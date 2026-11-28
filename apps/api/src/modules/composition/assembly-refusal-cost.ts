import type { MediaReceipt } from "@reelforge/contracts";
import { z } from "zod";
import { terminalBilledShot } from "../usage-budget/run-shot-receipt.js";
import type { Scoped, Step, Transaction } from "../runs/runs.types.js";

export async function manifestTerminalShotIds(db: Scoped, runId: string): Promise<string[]> {
  return (await terminalShots(db, runId)).map((step) => step.id);
}

function terminalShots(db: Scoped, runId: string): Promise<Step[]> {
  return db.videoRunStep
    .findMany({
      where: {
        runId,
        key: { startsWith: "shot-" },
        state: { in: ["SKIPPED", "FAILED"] },
        providerJobId: { not: null },
        costMinor: { not: null },
      },
    })
    .then((rows) => rows.filter(terminalBilledShot));
}

export async function refusalBillDeltas(
  db: Scoped,
  runId: string,
): Promise<
  { sequence: number; stepId: string | null; amount: number; bookedSequence: number | null }[]
> {
  const events = await db.runEvent.findMany({
    where: { runId, type: "provider_receipt", payload: { path: ["refusedBilling"], equals: true } },
    select: { sequence: true, stepId: true, payload: true },
  });
  if (!events.length) return [];
  const booked = new Map<string, number>();
  const steps = events.flatMap(({ stepId }) => (stepId ? [stepId] : []));
  const terminal = await db.runEvent.findMany({
    where: {
      runId,
      stepId: { in: steps },
      OR: [
        { type: "shot_refused" },
        { type: "step_failed", payload: { path: ["reason"], equals: "PROVIDER_FAILED" } },
      ],
    },
    select: { stepId: true, sequence: true },
    orderBy: { sequence: "asc" },
  });
  for (const { stepId, sequence } of terminal)
    if (stepId && !booked.has(stepId)) booked.set(stepId, sequence);
  return events.map(({ sequence, stepId, payload }) => ({
    sequence,
    stepId,
    bookedSequence: booked.get(stepId ?? "") ?? null,
    amount: z.object({ adjustmentMinor: z.int() }).parse(payload).adjustmentMinor,
  }));
}

type Delta = Awaited<ReturnType<typeof refusalBillDeltas>>[number];
export function renderRefusalDelta(
  deltas: Delta[],
  revision: number,
  included: string[] | undefined,
  legacyPublication: number | null,
): number | null {
  let total = 0;
  for (const entry of deltas) {
    if (entry.sequence <= revision) continue;
    if (included !== undefined) {
      if (entry.stepId && included.includes(entry.stepId)) total += entry.amount;
    } else {
      if (legacyPublication === null || entry.bookedSequence === null) return null;
      if (entry.bookedSequence < legacyPublication) total += entry.amount;
    }
  }
  return total;
}

/** Main keeps each original assembly row when archiving it and records its creation event. */
export async function legacyAssemblySequences(
  db: Scoped,
  runId: string,
): Promise<Map<string, number>> {
  const [rows, events] = await Promise.all([
    db.videoRunStep.findMany({
      where: {
        runId,
        state: "SUCCEEDED",
        OR: [{ key: "local:assembly" }, { key: { startsWith: "quality:assembly-history:" } }],
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.runEvent.findMany({
      where: { runId, type: "assembly_created" },
      select: { createdAt: true, payload: true, sequence: true },
      orderBy: { sequence: "asc" },
    }),
  ]);
  const created = events.filter(
    (event) => !z.object({ replay: z.literal(true) }).safeParse(event.payload).success,
  );
  if (rows.length !== created.length) return new Map();
  // Match only a complete, nonoverlapping sequence; client timestamps need not be identical.
  if (
    rows.some(
      (row, i) =>
        row.createdAt > created[i]!.createdAt ||
        (i > 0 && row.createdAt <= created[i - 1]!.createdAt),
    )
  )
    return new Map();
  return new Map(rows.map((row, i) => [row.id, created[i]!.sequence]));
}

export async function manifestRefreshMode(
  db: Scoped,
  runId: string,
): Promise<"billing" | "retry" | null> {
  // The correction event also covers manifests written by older workers before
  // descriptors were explicitly withdrawn. A failed rebuild never acknowledges it.
  const latest = await db.runEvent.findFirst({
    where: {
      runId,
      OR: [
        { type: { in: ["assembly_receipts_checked", "assembly_receipts_retry"] } },
        {
          type: "text_attempt_folded",
          payload: { path: ["manifestReceiptChanged"], equals: true },
        },
        { type: "provider_receipt", payload: { path: ["key"], string_starts_with: "shot-" } },
      ],
    },
    orderBy: { sequence: "desc" },
    select: { type: true },
  });
  if (!latest || latest.type === "assembly_receipts_checked") return null;
  return latest.type === "assembly_receipts_retry" ? "retry" : "billing";
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
