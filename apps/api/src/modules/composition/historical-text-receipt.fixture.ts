import {
  AssemblyManifestSchema,
  MediaReceiptSchema,
  type MediaReceipt,
} from "@reelforge/contracts";
import { json, type Artifact } from "../runs/runs.types.js";
import type { setupAssembly } from "./media-assembly.fixture.js";
import { vi, expect } from "vitest";
import type { Tenant } from "../runs/runs.fixture.js";
import { importLegacyTextAttempts } from "../usage-budget/legacy-text-import.js";
import { ingestMatchedTextReceipt } from "../usage-budget/text-attempt-receipt-recovery.js";
import { drainedLegacyIncarnation } from "../usage-budget/text-attempt-ops-schema.js";

export async function importHistoricalBooking(
  t: Tenant,
  dispatchKey: string,
): Promise<(actualMinor?: number) => Promise<void>> {
  const { workspaceId, channelId } = t.run;
  const step = await t.db.videoRunStep.findFirstOrThrow({
    where: { workspaceId, idempotencyKey: dispatchKey },
  });
  const reservation = await t.db.usageReservation.create({
    data: {
      workspaceId,
      channelId,
      correlationId: step.id,
      idempotencyKey: `m08:${dispatchKey}`,
      currency: "USD",
      category: "LLM",
      amountMinor: 7n,
      committedMinor: 7n,
      status: "COMMITTED",
      expiresAt: new Date(),
      committedAt: new Date(),
    },
  });
  await t.db.providerRequest.create({
    data: {
      workspaceId,
      channelId,
      correlationId: step.id,
      providerId: "gemini",
      capabilityId: "fixture-text",
      status: "SUCCEEDED",
      currency: "USD",
      estimatedCost: "0.07",
    },
  });
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
  const report = await importLegacyTextAttempts(t.db, {
    workspaceId,
    apply: true,
    oldWritersDrained: true,
    auditId: "fixture-upgrade",
  });
  expect(report.attempts).toContainEqual(
    expect.objectContaining({ attemptId: step.id, outcome: "completed" }),
  );
  return (actualMinor = 20): Promise<void> =>
    ingestMatchedTextReceipt(t.db, {
      target: {
        workspaceId,
        attemptId: step.id,
        dispatchKey,
        armNonce: `legacy:${reservation.id}`,
        incarnation: drainedLegacyIncarnation,
      },
      actor: "fixture-operator",
      source: "google-project-audit",
      reference: "audit#1",
      observedAt: new Date().toISOString(),
      googleId: "historical-google-id",
      currency: "USD",
      actualMinor,
    });
}

export async function attachHistoricalGoogleId(t: Tenant, dispatchKey: string): Promise<void> {
  const bill = await importHistoricalBooking(t, dispatchKey);
  await bill();
}

export async function historicalTextFixture(
  setup: Awaited<ReturnType<typeof setupAssembly>>,
  mode: "id-less" | "late ID" | "ambiguous",
): Promise<{ receipt: MediaReceipt; dispatchKey: string }> {
  const { t, run } = setup;
  const artifact = await t.artifacts.put(t.context, "refs", Buffer.from("{}"), "application/json");
  const key = "media:text:scriptwriter";
  const dispatchKey = `${run.id}:${key}:1`;
  const remoteId = mode === "ambiguous" ? "shared-google-interaction" : dispatchKey;
  const receipt = MediaReceiptSchema.parse({
    key,
    providerId: "gemini",
    providerJobId: remoteId,
    modelId: "fixture-text",
    promptVersion: "fixture:v1",
    seconds: 0,
    costMinor: 7,
    objectKey: artifact.objectKey,
    checksumSha256: artifact.checksumSha256,
    mimeType: "application/json",
  });
  await t.db.videoRunStep.createMany({
    data: [1, 2].map((attempt) => {
      const providerJobId =
        attempt === 1 ? remoteId : mode === "ambiguous" ? remoteId : "newer-google-id";
      return {
        workspaceId: run.workspaceId,
        runId: run.id,
        key,
        attempt,
        idempotencyKey: `${run.id}:${key}:${attempt}`,
        providerId: "gemini",
        providerJobId,
        state: "SUCCEEDED" as const,
        input: {},
        output: json({
          result: {
            output: setup.plan.script,
            dispatchKey: `${run.id}:${key}:${attempt}`,
            receipt: { ...receipt, providerJobId: attempt === 1 ? remoteId : providerJobId },
          },
        }),
      };
    }),
  });
  if (mode === "late ID") await attachHistoricalGoogleId(t, dispatchKey);
  return { receipt, dispatchKey };
}

export async function readArtifact(
  { t, run }: Awaited<ReturnType<typeof setupAssembly>>,
  artifact: Artifact,
): Promise<Buffer> {
  return t.storage.getObject({ workspaceId: run.workspaceId, objectKey: artifact.objectKey });
}

export function readReceipt(output: unknown): MediaReceipt {
  return MediaReceiptSchema.parse((output as { receipt: unknown }).receipt);
}

export async function repriceHistoricalShot(
  { t, run }: Awaited<ReturnType<typeof setupAssembly>>,
  key: string,
): Promise<MediaReceipt> {
  const step = await t.db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key } });
  const original = readReceipt(step.output);
  const corrected = {
    ...original,
    costBasis: "BILLED" as const,
    costMinor: original.costMinor + 11,
  };
  await t.db.videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key,
      attempt: 2,
      providerId: original.providerId,
      providerJobId: "different-reshoot",
      state: "SUCCEEDED",
      idempotencyKey: `${run.id}:${key}:2`,
      input: {},
      output: json({ receipt: { ...original, providerJobId: "different-reshoot", costMinor: 99 } }),
    },
  });
  await t.store.mutate(t.context, run.id, "provider_receipt", async (db) => {
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: {
        costMinor: corrected.costMinor,
        output: json({ ...(step.output as object), receipt: corrected }),
      },
    });
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id },
      data: { spentMinor: budget.spentMinor + corrected.costMinor - original.costMinor },
    });
    return { value: null, payload: { key } };
  });
  return corrected;
}
export async function readManifest(
  setup: Awaited<ReturnType<typeof setupAssembly>>,
  descriptors: Artifact[],
): Promise<ReturnType<typeof AssemblyManifestSchema.parse>> {
  const bytes = await readArtifact(
    setup,
    descriptors.find((a) => a.kind === "manifest")!,
  );
  return AssemblyManifestSchema.parse(JSON.parse(bytes.toString()));
}
