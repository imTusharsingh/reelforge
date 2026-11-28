import { createHash } from "node:crypto";
import { AssemblyManifestSchema, type AssemblyManifest } from "@reelforge/contracts";
import { z } from "zod";
import { StorageObjectNotFoundError, type StoragePort } from "../asset/storage/storage.port.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import {
  ArtifactSchema,
  json,
  type Artifact,
  type Context,
  type Json,
  type Run,
  type Scoped,
} from "../runs/runs.types.js";
import {
  legacyAssemblySequences,
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
export async function rebuildArchivedManifests(
  db: Scoped,
  run: Run,
  deltas: Awaited<ReturnType<typeof refusalBillDeltas>>,
  rebuild: (source: Artifact, delta: number) => Promise<Artifact | null>,
): Promise<{ value: null; payload: Json; eventType: string }> {
  const { rows, legacy } = await loadArchiveRows(db, run.id, deltas.length > 0);
  const written = new Map<string, Rebuild>();
  const failures: string[] = [];
  const unscoped: string[] = [];
  let retry = false;
  for (const { id, output, source } of rows) {
    const delta = renderRefusalDelta(
      deltas,
      output.manifestBillingRevision ?? 0,
      output.manifestTerminalShotIds,
      legacy.get(source.objectKey) ?? null,
    );
    if (delta === null) {
      unscoped.push(id);
      continue;
    }
    const key = JSON.stringify([source.objectKey, source.checksumSha256, delta]);
    if (!written.has(key)) {
      written.set(key, await attemptRebuild(source, delta, rebuild));
    }
    const { descriptor, problem } = written.get(key)!;
    if (problem === "retry") retry = true;
    if (problem === "invalid") {
      failures.push(id);
      await db.videoRunStep.updateMany({
        where: { id },
        data: { output: json({ ...output, manifestArchiveInvalid: true }) },
      });
    }
    if (descriptor)
      await db.videoRunStep.updateMany({
        where: { id },
        data: {
          output: replaceManifest({ ...output, manifestBillingRevision: run.revision }, descriptor),
        },
      });
  }
  return {
    value: null,
    payload: { manifests: written.size, invalidArchives: failures, unscopedArchives: unscoped },
    eventType: retry ? "assembly_receipts_retry" : "assembly_receipts_checked",
  };
}

async function loadArchiveRows(
  db: Scoped,
  runId: string,
  hasDeltas: boolean,
): Promise<ReturnType<typeof archiveRows>> {
  const where = {
    runId,
    output: { path: ["pendingManifest", "kind"], equals: "manifest" },
  };
  const pending = await db.videoRunStep.findMany({
    where,
    select: { id: true, key: true, output: true },
  });
  const legacySequences =
    hasDeltas &&
    pending.some(
      ({ output }) => assemblyOutput.safeParse(output).data?.manifestTerminalShotIds === undefined,
    )
      ? await legacyAssemblySequences(db, runId)
      : new Map<string, number>();
  return archiveRows(pending, legacySequences);
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
  try {
    return { descriptor: await rebuild(source, delta) };
  } catch (error) {
    if (error instanceof InvalidArchivedManifest) return { descriptor: null, problem: "invalid" };
    if (error instanceof ArchiveStorageUnavailable) return { descriptor: null, problem: "retry" };
    throw error;
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
