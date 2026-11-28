import { Logger } from "@nestjs/common";
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
type ArchiveSnapshot = Awaited<ReturnType<typeof prepareArchiveRebuilds>> & {
  sequence: number;
  prices: MediaReceipt[];
  historical: TextReceipt[];
};
type ArchiveJob = ArchiveSnapshot["jobs"][number];
type ArchiveProblem = Awaited<ReturnType<typeof rebuildArchiveJob>>;
type ArchiveAttempt = { job: ArchiveJob; completion: Promise<ArchiveProblem>; retry: boolean };
type ArchiveRefresh = {
  attempts: Map<string, ArchiveAttempt>;
  unscoped: string[];
  completion?: Promise<void>;
  finishing?: boolean;
};
const refreshes = new WeakMap<RunsStore, Map<string, ArchiveRefresh>>();
class ObsoleteArchiveRefresh extends Error {}
const logger = new Logger("AssemblyManifestRefresh");

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
  await waitForRefresh(startRefresh(store, artifacts, storage, context, runId, snapshot));
}

function startRefresh(
  store: RunsStore,
  artifacts: RunsArtifacts,
  storage: StoragePort,
  context: Context,
  runId: string,
  { sequence, jobs, unscoped, prices, historical }: ArchiveSnapshot,
): Promise<void> {
  const pending = refreshes.get(store) ?? new Map<string, ArchiveRefresh>();
  refreshes.set(store, pending);
  const key = `${context.workspaceId}:${runId}:${sequence}`;
  const refresh: ArchiveRefresh = pending.get(key) ?? { attempts: new Map(), unscoped };
  pending.set(key, refresh);
  if (!refresh.finishing) {
    refresh.unscoped = unscoped;
    for (const job of jobs)
      startArchive(refresh, job, () =>
        rebuildArchiveJob(store, context, runId, sequence, job, (source, delta) =>
          rewriteManifest(context, runId, source, prices, historical, delta, storage, artifacts),
        ),
      );
  }
  return (refresh.completion ??= finalizeRefresh(store, context, runId, sequence, refresh)
    .catch((error: unknown) => {
      if (error instanceof ObsoleteArchiveRefresh) return;
      logger.warn(`Manifest refresh deferred for run ${runId}`);
      throw error;
    })
    .finally(() => pending.delete(key)));
}

function startArchive(
  refresh: ArchiveRefresh,
  job: ArchiveJob,
  rebuild: () => Promise<ArchiveProblem>,
): void {
  // Retrying this archive does not restart or wait behind a blocked sibling.
  const key = JSON.stringify([
    job.source.objectKey,
    job.source.checksumSha256,
    job.delta,
    job.rows.map(({ id, revision }) => `${id}:${revision}`).sort(),
  ]);
  const previous = refresh.attempts.get(key);
  if (previous && !previous.retry) return;
  const attempt: ArchiveAttempt = {
    job,
    retry: false,
    completion: rebuild()
      .catch((): ArchiveProblem => {
        // A database or storage failure in one attempt must not poison the revision's finalizer.
        logger.warn(`Archive rebuild deferred for row ${job.rows[0]?.id}`);
        return "retry";
      })
      .then((result) => {
        attempt.retry = result === "retry";
        return result;
      }),
  };
  refresh.attempts.set(key, attempt);
}

async function settledArchives(
  refresh: ArchiveRefresh,
): Promise<{ jobs: ArchiveJob[]; results: ArchiveProblem[] }> {
  for (;;) {
    const entries = [...refresh.attempts];
    const results = await Promise.all(entries.map(([, attempt]) => attempt.completion));
    if (
      entries.length === refresh.attempts.size &&
      entries.every(([key, attempt]) => refresh.attempts.get(key) === attempt)
    ) {
      refresh.finishing = true;
      return { jobs: entries.map(([, attempt]) => attempt.job), results };
    }
  }
}

async function waitForRefresh(completion: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // This bounds the caller's wait, not storage or the guarded publication of its result.
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(function archiveRequestDeadline() {
        resolve();
      }, 10_000);
    });
    await Promise.race([completion, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

async function finalizeRefresh(
  store: RunsStore,
  context: Context,
  runId: string,
  sequence: number,
  refresh: ArchiveRefresh,
): Promise<void> {
  const { jobs, results } = await settledArchives(refresh);
  const { unscoped } = refresh;
  if (!(await manifestRefreshMode(store.scoped(context), runId))) return;
  await store.mutate(context, runId, "assembly_receipts_snapshot", async (db) => {
    if (
      (await manifestBillingSequence(db, runId)) !== sequence ||
      !(await manifestRefreshMode(db, runId))
    )
      // RunsStore increments the revision before invoking this callback; roll it back on stale work.
      throw new ObsoleteArchiveRefresh();
    const observed = new Set([
      ...unscoped,
      ...jobs.flatMap((job, i) => (results[i] === "retry" ? [] : job.rows.map(({ id }) => id))),
    ]);
    const retry = (await pendingArchiveRows(db, runId)).some(({ id, output }) => {
      const pending = assemblyOutput.safeParse(output).data;
      return !observed.has(id) && !!pending?.pendingManifest && !pending.manifestArchiveInvalid;
    });
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
