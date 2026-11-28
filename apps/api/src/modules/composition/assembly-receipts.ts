import {
  manifestHasBillingChange,
  rebuiltTotal,
  refusalBillDeltas,
} from "./assembly-refusal-cost.js";
import { deriveTextAttempt } from "../usage-budget/text-attempt-store.js";
import { remoteTextId } from "../usage-budget/text-evidence.js";
import { LocalAssemblyFailure } from "./local-assembly-failure.js";
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
  type Step,
} from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import type { StoragePort } from "../asset/storage/storage.port.js";

type TextReceipt = MediaReceipt & { dispatchKey: string };
type ReceiptStep = Pick<Step, "key" | "output" | "providerId" | "providerJobId" | "idempotencyKey">;

const stepReceipt = z.object({ receipt: z.unknown().optional(), result: z.unknown().optional() });

function readReceipt(step: Pick<Step, "output">): MediaReceipt | undefined {
  const output = stepReceipt.safeParse(step.output).data;
  const result = stepReceipt.safeParse(output?.result).data;
  return MediaReceiptSchema.safeParse(output?.receipt ?? result?.receipt).data;
}

const textEvidence = {
  select: { sequence: true, kind: true, nonce: true, data: true, eventKey: true },
  orderBy: { sequence: "asc" as const },
};

function planningReceipt(
  step: Step & {
    textEvidence: Parameters<typeof deriveTextAttempt>[1];
    textProjection: { grossMinor: number; netMinor: number } | null;
  },
): TextReceipt | undefined {
  const receipt = readReceipt(step);
  if (
    !receipt ||
    receipt.key !== step.key ||
    (step.providerId && step.providerId !== receipt.providerId) ||
    (receipt.dispatchKey && receipt.dispatchKey !== step.idempotencyKey)
  )
    return;
  const saved = remoteTextId(step, receipt.providerJobId);
  const attached = remoteTextId(step, step.providerJobId);
  const attempt = deriveTextAttempt(step.idempotencyKey, step.textEvidence);
  const verified = attempt?.googleId;
  const ids = new Set([saved, attached, verified].filter((id): id is string => !!id));
  if (ids.size > 1) return;
  return {
    ...receipt,
    ...(step.textProjection && { postedNetMinor: step.textProjection.netMinor }),
    dispatchKey: step.idempotencyKey,
    providerJobId: verified ?? saved ?? attached,
    ...(attempt?.actualMinor != null &&
      step.textProjection?.grossMinor === attempt.actualMinor && {
        costMinor: attempt.actualMinor,
        costBasis: "BILLED",
      }),
  };
}

export async function assemblyReceipts(db: Scoped, runId: string): Promise<MediaReceipt[]> {
  const steps = await db.videoRunStep.findMany({
    where: { runId, state: "SUCCEEDED", NOT: { key: { startsWith: "shot-" } } },
    include: { textEvidence, textProjection: { select: { grossMinor: true, netMinor: true } } },
    orderBy: [{ createdAt: "asc" }, { attempt: "asc" }],
  });
  return steps.flatMap((step) => {
    const receipt = step.key.startsWith("media:text:") ? planningReceipt(step) : readReceipt(step);
    return receipt ? [receipt] : [];
  });
}

function validShotReceipt(step: ReceiptStep | undefined): MediaReceipt | undefined {
  if (!step?.providerJobId || step.providerJobId === step.idempotencyKey) return;
  const receipt = readReceipt(step);
  const artifacts = z
    .object({ storageArtifacts: z.array(ArtifactSchema) })
    .safeParse(step.output).data;
  const clips = artifacts?.storageArtifacts.filter((artifact) => artifact.kind === "clips");
  if (
    clips?.length === 1 &&
    clips[0]?.contentType === "video/mp4" &&
    clips[0].objectKey === receipt?.objectKey &&
    clips[0].checksumSha256 === receipt?.checksumSha256 &&
    receipt?.key === step.key &&
    receipt.providerId === step.providerId &&
    receipt.providerJobId === step.providerJobId &&
    receipt.mimeType === "video/mp4"
  )
    return receipt;
}

export function missingShotReceipt(): LocalAssemblyFailure {
  return new LocalAssemblyFailure(
    "ASSEMBLY_SHOT_RECEIPT_MISSING",
    "Every shot requires a playable video receipt for its latest successful attempt. Check the missing shot before making a new Short.",
  );
}

export async function selectedShotReceipts(
  db: Scoped,
  runId: string,
  ordinals: readonly number[],
): Promise<MediaReceipt[]> {
  const keys = ordinals.map((ordinal) => `shot-${ordinal}`);
  const steps = await db.videoRunStep.findMany({
    where: { runId, state: "SUCCEEDED", key: { in: keys } },
    orderBy: { attempt: "desc" },
  });
  return keys.map((key) => {
    // Select the attempt before inspecting its receipt: a malformed reshoot must
    // not silently substitute an older clip from another successful attempt.
    const receipt = validShotReceipt(steps.find((step) => step.key === key));
    if (!receipt) throw missingShotReceipt();
    return receipt;
  });
}

const assemblyOutput = z
  .object({
    storageArtifacts: z.array(ArtifactSchema),
    result: z
      .object({ storageArtifacts: z.array(ArtifactSchema) })
      .passthrough()
      .optional(),
    pendingManifest: ArtifactSchema.optional(),
    manifestBillingRevision: z.int().nonnegative().optional(),
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
  });
  return shots.flatMap((step) => {
    const receipt = validShotReceipt(step);
    return receipt ? [receipt] : [];
  });
}

function sameReceiptArtifact(a: MediaReceipt, b: MediaReceipt): boolean {
  return (
    a.key === b.key &&
    a.providerId === b.providerId &&
    a.objectKey === b.objectKey &&
    a.checksumSha256 === b.checksumSha256 &&
    a.mimeType === b.mimeType
  );
}

// Preserve the exact jobs and media used by this render, even after later reshoots.
export function currentPrices(
  rendered: MediaReceipt[],
  current: MediaReceipt[],
): MediaReceipt[] | null {
  const priced: MediaReceipt[] = [];
  for (const item of rendered) {
    const matches = current.filter(
      (shot) => sameReceiptArtifact(item, shot) && item.providerJobId === shot.providerJobId,
    );
    if (matches.length > 1) return null;
    priced.push(matches[0] ?? item);
  }
  return priced;
}

async function historicalTextReceipts(db: Scoped, runId: string): Promise<TextReceipt[]> {
  const steps = await db.videoRunStep.findMany({
    where: { runId, state: "SUCCEEDED", key: { startsWith: "media:text:" } },
    include: { textEvidence, textProjection: { select: { grossMinor: true, netMinor: true } } },
  });
  return steps.flatMap((step) => {
    const receipt = planningReceipt(step);
    return receipt ? [receipt] : [];
  });
}

function normalizeHistoricalText(
  receipts: MediaReceipt[],
  historical: TextReceipt[],
): MediaReceipt[] | null {
  const resolved: MediaReceipt[] = [];
  for (const item of receipts) {
    if (!item.key.startsWith("media:text:")) {
      resolved.push(item);
      continue;
    }
    const matching = historical.filter(
      (candidate) =>
        sameReceiptArtifact(item, candidate) &&
        (!item.dispatchKey || item.dispatchKey === candidate.dispatchKey) &&
        (item.providerJobId === null
          ? item.dispatchKey === candidate.dispatchKey
          : item.providerJobId === candidate.dispatchKey ||
            item.providerJobId === candidate.providerJobId),
    );
    // Never infer the attempt merely from an identical output artifact.
    if (matching.length !== 1) return null;
    const { providerJobId, dispatchKey, costMinor, costBasis, postedNetMinor } = matching[0]!;
    resolved.push({
      ...item,
      providerJobId,
      dispatchKey,
      ...(postedNetMinor !== undefined && { postedNetMinor }),
      ...(costBasis === "BILLED" && { costMinor, costBasis }),
    });
  }
  return resolved;
}

export async function publicationPrices(
  db: Scoped,
  runId: string,
  rendered: MediaReceipt[],
): Promise<MediaReceipt[] | null> {
  const shots = currentPrices(rendered, await shotReceipts(db, runId));
  return shots && normalizeHistoricalText(shots, await historicalTextReceipts(db, runId));
}

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
  const bytes = await storage.getObject({
    workspaceId: context.workspaceId,
    objectKey: source.objectKey,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== source.checksumSha256)
    throw new Error("Stored assembly manifest checksum mismatch");
  const manifest = AssemblyManifestSchema.parse(JSON.parse(bytes.toString()));
  if (manifest.workspaceId !== context.workspaceId || manifest.runId !== runId)
    throw new Error("Stored assembly manifest provenance mismatch");
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
  if (!(await manifestHasBillingChange(store.scoped(context), runId))) return;
  await store.mutate(context, runId, "assembly_receipts_checked", async (db, run) => {
    await invalidateAssemblyManifests(db, runId);
    const pending = await db.videoRunStep.findMany({ where, select: { id: true, output: true } });
    const prices = await shotReceipts(db, runId);
    const historical = await historicalTextReceipts(db, runId);
    const deltas = await refusalBillDeltas(db, runId);
    const written = new Map<string, Artifact | null>();
    for (const step of pending) {
      const output = assemblyOutput.parse(step.output);
      const source = output.pendingManifest!;
      // Deployed manifests predate the dedicated bill event and start at zero.
      const revision = output.manifestBillingRevision ?? 0;
      const key = JSON.stringify([source.objectKey, revision]);
      if (!written.has(key)) {
        const delta = deltas.reduce(
          (sum, entry) => sum + (entry.sequence > revision ? entry.amount : 0),
          0,
        );
        written.set(
          key,
          await rewriteManifest(
            context,
            runId,
            source,
            prices,
            historical,
            delta,
            storage,
            artifacts,
          ),
        );
      }
      const descriptor = written.get(key);
      if (descriptor)
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            output: replaceManifest(
              { ...output, manifestBillingRevision: run.revision },
              descriptor,
            ),
          },
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
  const { storageArtifacts, pendingManifest, manifestBillingRevision } = assemblyOutput.parse(
    cached.output,
  );
  return json({
    result: { storageArtifacts },
    storageArtifacts,
    ...(pendingManifest && { pendingManifest }),
    ...(manifestBillingRevision !== undefined && { manifestBillingRevision }),
  });
}

export function assertAssemblyCost(spentMinor: number): void {
  if (!AssemblyManifestSchema.shape.totalCostMinor.safeParse(spentMinor).success)
    throw new LocalAssemblyFailure(
      "ASSEMBLY_BUDGET_OVERRUN",
      "The final provider charges exceed the assembly delivery budget. Review the recorded spend before starting a new Short.",
    );
}

export async function assertCurrentAssemblyCost(db: Scoped, runId: string): Promise<void> {
  const budget = await db.budgetEnvelope.findFirst({
    where: { runId },
    select: { spentMinor: true },
  });
  if (budget) assertAssemblyCost(budget.spentMinor);
}

export function artifactTooLarge(): LocalAssemblyFailure {
  return new LocalAssemblyFailure(
    "ASSEMBLY_ARTIFACT_TOO_LARGE",
    "The assembled video exceeds the 128 MiB delivery limit. Use smaller source media before making a new Short.",
  );
}
