import { createHash } from "node:crypto";
import { AssemblyManifestSchema, type AssemblyManifest } from "@reelforge/contracts";
import { z } from "zod";
import { StorageObjectNotFoundError, type StoragePort } from "../asset/storage/storage.port.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import {
  ArtifactSchema,
  json,
  type Artifact,
  type Context,
  type Json,
  type Run,
  type Scoped,
  type Step,
} from "../runs/runs.types.js";
import {
  legacyAssemblySequences,
  manifestBillingSequence,
  manifestTerminalShotIds,
  renderRefusalDelta,
  type refusalBillDeltas,
} from "./assembly-refusal-cost.js";

export const assemblyOutput = z
  .object({
    storageArtifacts: z.array(ArtifactSchema),
    result: z
      .object({ storageArtifacts: z.array(ArtifactSchema) })
      .passthrough()
      .optional(),
    pendingManifest: ArtifactSchema.optional(),
    manifestBillingRevision: z.int().nonnegative().optional(),
    manifestTerminalShotIds: z.array(z.uuid()).optional(),
    manifestArchiveInvalid: z.boolean().optional(),
  })
  .passthrough();
type AssemblyOutput = z.infer<typeof assemblyOutput>;

export function replaceManifest(output: AssemblyOutput, descriptor: Artifact | null): Json {
  const media = output.storageArtifacts.filter((a) => a.kind !== "manifest");
  const storageArtifacts = descriptor ? [...media, descriptor] : media;
  const { pendingManifest, ...fields } = output;
  return json({
    ...fields,
    storageArtifacts,
    ...(output.result && { result: { ...output.result, storageArtifacts } }),
    ...(!descriptor && {
      pendingManifest:
        pendingManifest ?? output.storageArtifacts.find((a) => a.kind === "manifest"),
    }),
  });
}

class InvalidArchivedManifest extends Error {}
class ArchiveStorageUnavailable extends Error {}

export async function readManifestSource(
  storage: StoragePort,
  context: Context,
  source: Artifact,
  runId: string,
): Promise<z.infer<typeof AssemblyManifestSchema>> {
  let bytes: Buffer;
  try {
    bytes = await storage.getObject({
      workspaceId: context.workspaceId,
      objectKey: source.objectKey,
    });
  } catch (cause) {
    if (cause instanceof StorageObjectNotFoundError)
      throw new InvalidArchivedManifest("Archive missing", { cause });
    throw new ArchiveStorageUnavailable("Archive read failed", { cause });
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source.checksumSha256)
    throw new InvalidArchivedManifest("Manifest checksum mismatch");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString());
  } catch {
    throw new InvalidArchivedManifest("Manifest JSON is invalid");
  }
  const manifest = AssemblyManifestSchema.safeParse(raw).data;
  if (!manifest || manifest.workspaceId !== context.workspaceId || manifest.runId !== runId)
    throw new InvalidArchivedManifest("Manifest schema or provenance mismatch");
  return manifest;
}

type Rebuild = { descriptor: Artifact | null; problem?: "invalid" | "retry" };
export async function prepareArchiveRebuilds(
  db: Scoped,
  runId: string,
  deltas: Awaited<ReturnType<typeof refusalBillDeltas>>,
): Promise<{ jobs: ArchiveJob[]; unscoped: string[] }> {
  const pending = await pendingArchiveRows(db, runId);
  const legacySequences =
    deltas.length &&
    pending.some(
      ({ output }) => assemblyOutput.safeParse(output).data?.manifestTerminalShotIds === undefined,
    )
      ? await legacyAssemblySequences(db, runId)
      : new Map<string, number>();
  const { rows, legacy } = archiveRows(pending, legacySequences);
  const unscoped: string[] = [];
  const jobs = new Map<string, ArchiveJob>();
  for (const { id, output, source } of rows) {
    const revision = output.manifestBillingRevision ?? 0;
    const delta = renderRefusalDelta(
      deltas,
      revision,
      output.manifestTerminalShotIds,
      legacy.get(source.objectKey) ?? null,
    );
    if (delta === null) {
      unscoped.push(id);
      continue;
    }
    const key = JSON.stringify([source.objectKey, source.checksumSha256, delta]);
    const job = jobs.get(key);
    const row = { id, revision };
    if (job) job.rows.push(row);
    else jobs.set(key, { source, delta, rows: [row] });
  }
  return { jobs: [...jobs.values()], unscoped };
}

type ArchiveJob = { source: Artifact; delta: number; rows: { id: string; revision: number }[] };

export function pendingArchiveRows(
  db: Scoped,
  runId: string,
): Promise<Pick<Step, "id" | "key" | "output">[]> {
  return db.videoRunStep.findMany({
    where: { runId, output: { path: ["pendingManifest", "kind"], equals: "manifest" } },
    select: { id: true, key: true, output: true },
  });
}

export async function rebuildArchiveJob(
  store: RunsStore,
  context: Context,
  runId: string,
  sequence: number,
  job: ArchiveJob,
  rebuild: (source: Artifact, delta: number) => Promise<Artifact | null>,
): Promise<Rebuild["problem"]> {
  const result = await attemptRebuild(job.source, job.delta, rebuild);
  if (!result.descriptor && result.problem !== "invalid") return result.problem;
  return withArchiveRunLock(store, context, runId, async (db) => {
    if ((await manifestBillingSequence(db, runId)) !== sequence) return;
    for (const row of job.rows) {
      const step = await db.videoRunStep.findFirst({ where: { runId, id: row.id } });
      const output = assemblyOutput.safeParse(step?.output).data;
      if (!output?.pendingManifest || output.manifestArchiveInvalid) continue;
      if (
        output.pendingManifest.objectKey !== job.source.objectKey ||
        output.pendingManifest.checksumSha256 !== job.source.checksumSha256 ||
        (output.manifestBillingRevision ?? 0) !== row.revision
      )
        return "retry";
      const next = result.descriptor
        ? replaceManifest(
            { ...output, manifestBillingRevision: Math.max(row.revision, sequence) },
            result.descriptor,
          )
        : json({ ...output, manifestArchiveInvalid: true });
      const saved = await db.videoRunStep.updateMany({
        where: { id: row.id, updatedAt: step!.updatedAt },
        data: { output: next },
      });
      if (!saved.count) return "retry";
    }
    return result.problem;
  });
}

export function withArchiveRunLock<T>(
  store: RunsStore,
  context: Context,
  runId: string,
  work: (db: Scoped) => Promise<T>,
): Promise<T> {
  return store.db.$transaction(async (tx) => {
    // Lock in the same order as billing. Storage never runs inside this transaction.
    await tx.$queryRaw`SELECT id FROM video_runs WHERE workspace_id = ${context.workspaceId}::uuid
      AND id = ${runId}::uuid FOR UPDATE`;
    return work(store.scoped(context, tx));
  });
}

function archiveRows(
  pending: { id: string; key: string; output: unknown }[],
  sequences: Map<string, number>,
): {
  rows: { id: string; output: AssemblyOutput; source: Artifact }[];
  legacy: Map<string, number | null>;
} {
  const legacy = new Map<string, number | null>();
  const rows = pending.flatMap((step) => {
    const output = assemblyOutput.safeParse(step.output).data;
    if (!output?.pendingManifest || output.manifestArchiveInvalid) return [];
    if (step.key === "local:assembly" || step.key.startsWith("quality:assembly-history:")) {
      const key = output.pendingManifest.objectKey;
      const origin = sequences.get(step.id) ?? null;
      const prior = legacy.get(key);
      legacy.set(key, prior === undefined || prior === origin ? origin : null);
    }
    return [{ id: step.id, output, source: output.pendingManifest }];
  });
  return { rows, legacy };
}

async function attemptRebuild(
  source: Artifact,
  delta: number,
  rebuild: (source: Artifact, delta: number) => Promise<Artifact | null>,
): Promise<Rebuild> {
  // A stalled object must not keep the request or retry marker pending indefinitely.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new ArchiveStorageUnavailable("Archive I/O timed out")),
        10_000,
      );
    });
    return { descriptor: await Promise.race([rebuild(source, delta), deadline]) };
  } catch (error) {
    if (error instanceof InvalidArchivedManifest) return { descriptor: null, problem: "invalid" };
    if (error instanceof ArchiveStorageUnavailable) return { descriptor: null, problem: "retry" };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeManifestSource(
  artifacts: RunsArtifacts,
  context: Context,
  manifest: AssemblyManifest,
): Promise<Artifact> {
  try {
    return await artifacts.put(
      context,
      "manifest",
      Buffer.from(JSON.stringify(manifest)),
      "application/json",
    );
  } catch (cause) {
    throw new ArchiveStorageUnavailable("Archive write failed", { cause });
  }
}

export async function saveAssemblyOutput(
  db: Scoped,
  run: Run,
  revision: number,
  storageArtifacts: Artifact[],
): Promise<void> {
  await db.videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: "local:assembly",
      idempotencyKey: `${run.id}:local:assembly:1`,
      attempt: 1,
      state: "SUCCEEDED",
      input: {},
      output: json({
        storageArtifacts,
        manifestBillingRevision: revision,
        manifestTerminalShotIds: await manifestTerminalShotIds(db, run.id),
      }),
      finishedAt: new Date(),
    },
  });
}
