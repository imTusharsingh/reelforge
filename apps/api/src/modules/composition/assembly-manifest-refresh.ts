import { AssemblyManifestSchema, type MediaReceipt } from "@reelforge/contracts";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Artifact, Context } from "../runs/runs.types.js";
import {
  assemblyOutput,
  pendingArchiveRows,
  prepareArchiveRebuilds,
  readManifestSource,
  rebuildArchiveJob,
  withArchiveRunLock,
  writeManifestSource,
} from "./assembly-archive.js";
import {
  currentPrices,
  historicalTextReceipts,
  invalidateAssemblyManifests,
  normalizeHistoricalText,
  shotReceipts,
} from "./assembly-receipts.js";
import {
  manifestBillingSequence,
  manifestRefreshMode,
  rebuiltTotal,
  refusalBillDeltas,
} from "./assembly-refusal-cost.js";

type TextReceipt = Awaited<ReturnType<typeof historicalTextReceipts>>[number];

async function rewriteManifest(
  context: Context,
  runId: string,
  source: Artifact,
  current: MediaReceipt[],
  historical: TextReceipt[],
  refusedDelta: number,
  storage: StoragePort,
  artifacts: RunsArtifacts,
): Promise<Artifact | null> {
  const manifest = await readManifestSource(storage, context, source, runId);
  const priced = currentPrices(manifest.receipts, current);
  const receipts = priced && normalizeHistoricalText(priced, historical);
  if (!receipts) return null;
  const receiptTotal = rebuiltTotal(manifest, receipts);
  if (receiptTotal === null) return null;
  const totalCostMinor = receiptTotal + refusedDelta;
  // A manifest over the delivery contract's cap stays invalidated. The ledger keeps the actual cost.
  if (!AssemblyManifestSchema.shape.totalCostMinor.safeParse(totalCostMinor).success) return null;
  if (
    JSON.stringify(receipts) === JSON.stringify(manifest.receipts) &&
    totalCostMinor === manifest.totalCostMinor
  )
    return source;
  return writeManifestSource(artifacts, context, { ...manifest, receipts, totalCostMinor });
}

export async function refreshAssemblyManifests(
  store: RunsStore,
  artifacts: RunsArtifacts,
  storage: StoragePort,
  context: Context,
  runId: string,
): Promise<void> {
  if (!(await manifestRefreshMode(store.scoped(context), runId))) return;
  const snapshot = await withArchiveRunLock(store, context, runId, async (db) => {
    const mode = await manifestRefreshMode(db, runId);
    if (!mode) return null;
    const sequence = await manifestBillingSequence(db, runId);
    if (mode === "billing") await invalidateAssemblyManifests(db, runId, sequence);
    const [prices, historical, deltas] = await Promise.all([
      shotReceipts(db, runId),
      historicalTextReceipts(db, runId),
      refusalBillDeltas(db, runId),
    ]);
    return { ...(await prepareArchiveRebuilds(db, runId, deltas)), sequence, prices, historical };
  });
  if (!snapshot) return;
  const { jobs, unscoped, sequence, prices, historical } = snapshot;
  const results = await Promise.all(
    jobs.map((job) =>
      rebuildArchiveJob(store, context, runId, sequence, job, (source, delta) =>
        rewriteManifest(context, runId, source, prices, historical, delta, storage, artifacts),
      ),
    ),
  );
  await store.mutate(context, runId, "assembly_receipts_snapshot", async (db) => {
    if (
      (await manifestBillingSequence(db, runId)) !== sequence ||
      !(await manifestRefreshMode(db, runId))
    )
      return { value: null, payload: {} };
    const observed = new Set([...unscoped, ...jobs.flatMap((job) => job.rows.map(({ id }) => id))]);
    const unseen = (await pendingArchiveRows(db, runId)).some(({ id, output }) => {
      const pending = assemblyOutput.safeParse(output).data;
      return !observed.has(id) && !!pending?.pendingManifest && !pending.manifestArchiveInvalid;
    });
    const retry = unseen || results.includes("retry");
    return {
      value: null,
      eventType: retry ? "assembly_receipts_retry" : "assembly_receipts_checked",
      payload: {
        manifests: jobs.length,
        unscopedArchives: unscoped,
        invalidArchives: jobs.flatMap((job, i) =>
          results[i] === "invalid" ? job.rows.map(({ id }) => id) : [],
        ),
      },
    };
  });
}
