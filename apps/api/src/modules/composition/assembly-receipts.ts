import { createHash } from "node:crypto";
import {
  AssemblyManifestSchema,
  MediaReceiptSchema,
  type MediaReceipt,
} from "@reelforge/contracts";
import { z } from "zod";
import {
  ArtifactSchema,
  json,
  type Artifact,
  type Context,
  type Json,
  type Scoped,
} from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import type { StoragePort } from "../asset/storage/storage.port.js";

const assemblyOutput = z
  .object({
    storageArtifacts: z.array(ArtifactSchema),
    result: z
      .object({ storageArtifacts: z.array(ArtifactSchema) })
      .passthrough()
      .optional(),
    pendingManifest: ArtifactSchema.optional(),
  })
  .passthrough();
type AssemblyOutput = z.infer<typeof assemblyOutput>;

function replaceManifest(output: AssemblyOutput, descriptor: Artifact | null): Json {
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

// The billing transaction withdraws every published copy. Object storage is never a
// prerequisite for recording a liability, and a crash leaves a durable rebuild request.
export async function invalidateAssemblyManifests(db: Scoped, runId: string): Promise<void> {
  const steps = await db.videoRunStep.findMany({
    where: {
      runId,
      state: "SUCCEEDED",
      OR: [
        { key: { in: ["local:assembly", "ASSEMBLING", "REEDIT"] } },
        { key: { startsWith: "quality:assembly-history:" } },
      ],
    },
    select: { id: true, output: true },
  });
  for (const step of steps) {
    const parsed = assemblyOutput.safeParse(step.output);
    if (
      !parsed.success ||
      !parsed.data.storageArtifacts.some((a) => a.kind === "final") ||
      !parsed.data.storageArtifacts.some((a) => a.kind === "manifest")
    )
      continue;
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: { output: replaceManifest(parsed.data, null) },
    });
  }
}

export async function shotReceipts(db: Scoped, runId: string): Promise<MediaReceipt[]> {
  const shots = await db.videoRunStep.findMany({
    where: { runId, key: { startsWith: "shot-" }, state: "SUCCEEDED" },
    select: { output: true },
  });
  return shots.flatMap(({ output }) => {
    const result = z.object({ receipt: MediaReceiptSchema }).safeParse(output);
    return result.success ? [result.data.receipt] : [];
  });
}

// Preserve the exact jobs and media used by this render, even after later reshoots.
export function currentPrices(rendered: MediaReceipt[], current: MediaReceipt[]): MediaReceipt[] {
  return rendered.map(
    (item) =>
      current.find(
        (shot) =>
          shot.key === item.key &&
          shot.providerId === item.providerId &&
          shot.providerJobId === item.providerJobId &&
          shot.objectKey === item.objectKey,
      ) ?? item,
  );
}

async function rewriteManifest(
  context: Context,
  runId: string,
  source: Artifact,
  current: MediaReceipt[],
  storage: StoragePort,
  artifacts: RunsArtifacts,
): Promise<Artifact | null> {
  const bytes = await storage.getObject({
    workspaceId: context.workspaceId,
    objectKey: source.objectKey,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== source.checksumSha256)
    throw new Error("Stored assembly manifest checksum mismatch");
  const manifest = AssemblyManifestSchema.parse(JSON.parse(bytes.toString()));
  if (manifest.workspaceId !== context.workspaceId || manifest.runId !== runId)
    throw new Error("Stored assembly manifest provenance mismatch");
  const receipts = currentPrices(manifest.receipts, current);
  const totalCostMinor =
    manifest.totalCostMinor +
    receipts.reduce(
      (delta, receipt, i) => delta + receipt.costMinor - manifest.receipts[i]!.costMinor,
      0,
    );
  // A manifest over the delivery contract's cap stays invalidated. The ledger keeps the actual cost.
  if (!AssemblyManifestSchema.shape.totalCostMinor.safeParse(totalCostMinor).success) return null;
  if (
    JSON.stringify(receipts) === JSON.stringify(manifest.receipts) &&
    totalCostMinor === manifest.totalCostMinor
  )
    return source;
  return artifacts.put(
    context,
    "manifest",
    Buffer.from(JSON.stringify({ ...manifest, receipts, totalCostMinor })),
    "application/json",
  );
}

export async function refreshAssemblyManifests(
  store: RunsStore,
  artifacts: RunsArtifacts,
  storage: StoragePort,
  context: Context,
  runId: string,
): Promise<void> {
  const where = { runId, output: { path: ["pendingManifest", "kind"], equals: "manifest" } };
  // The correction event also covers manifests written by older workers before
  // descriptors were explicitly withdrawn. A failed rebuild never acknowledges it.
  const latest = await store.scoped(context).runEvent.findFirst({
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
  if (latest?.type !== "provider_receipt") return;
  await store.mutate(context, runId, "assembly_receipts_checked", async (db) => {
    await invalidateAssemblyManifests(db, runId);
    const pending = await db.videoRunStep.findMany({ where, select: { id: true, output: true } });
    const prices = await shotReceipts(db, runId);
    const written = new Map<string, Artifact | null>();
    for (const step of pending) {
      const output = assemblyOutput.parse(step.output);
      const source = output.pendingManifest!;
      if (!written.has(source.objectKey))
        written.set(
          source.objectKey,
          await rewriteManifest(context, runId, source, prices, storage, artifacts),
        );
      const descriptor = written.get(source.objectKey);
      if (descriptor)
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: { output: replaceManifest(output, descriptor) },
        });
    }
    return { value: null, payload: { manifests: written.size } };
  });
}

export async function assemblyStageOutput(
  db: Scoped,
  runId: string,
  result: Json,
  artifacts: Artifact[],
): Promise<Json> {
  const cached = await db.videoRunStep.findFirst({
    where: { runId, key: "local:assembly", state: "SUCCEEDED" },
    select: { output: true },
  });
  if (!cached) return json({ result, storageArtifacts: artifacts });
  const { storageArtifacts, pendingManifest } = assemblyOutput.parse(cached.output);
  return json({
    result: { storageArtifacts },
    storageArtifacts,
    ...(pendingManifest && { pendingManifest }),
  });
}
