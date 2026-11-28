import { vi, expect } from "vitest";
import type { Tenant } from "../runs/runs.fixture.js";
import { importLegacyTextAttempts } from "../usage-budget/legacy-text-import.js";
import { ingestMatchedTextReceipt } from "../usage-budget/text-attempt-receipt-recovery.js";
import { drainedLegacyIncarnation } from "../usage-budget/text-attempt-ops-schema.js";

export async function attachHistoricalGoogleId(t: Tenant, dispatchKey: string): Promise<void> {
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
  await ingestMatchedTextReceipt(t.db, {
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
    actualMinor: 20,
  });
}
