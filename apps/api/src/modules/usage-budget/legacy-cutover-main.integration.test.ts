import type { VideoGenPort } from "@reelforge/ai-providers";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderLedger } from "../openai/provider-ledger.js";
import { artifact, catalog, shot } from "../openai/provider.fixture.js";
import { runsFixture } from "../runs/runs.fixture.js";
import { historicalCredit } from "./legacy-credit-cutover.fixture.js";
import { legacy } from "./legacy-text-import.fixture.js";
import { importLegacyTextAttempts } from "./legacy-text-import.js";
import { ADMISSION_ORDERING } from "./run-admission-state.js";

describe.skipIf(!process.env.DATABASE_URL)("main deployment cutover", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it.each(["RESERVED", "EXPIRED"] as const)(
    "releases a drained main preflight with a %s reservation and no dispatch marker",
    async (status) => {
      const t = await fixture.tenant();
      const { workspaceId, id: runId } = t.run;
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
      const step = await legacy(t, "main-preflight", {
        code: "PENDING",
        expired: status === "EXPIRED",
        metadata: { admissionOrdering: ADMISSION_ORDERING, dispatched: false, costKnown: false },
      });
      const where = { workspaceId, correlationId: step.id };
      await t.db.usageReservation.updateMany({ where, data: { category: "VIDEO_MEDIA" } });
      await t.db.budgetEnvelope.upsert({
        where: { workspaceId_runId: { workspaceId, runId } },
        create: { workspaceId, runId, spentMinor: 0, reservedMinor: 7 },
        update: { spentMinor: 0, reservedMinor: 7 },
      });
      await t.store.mutate(t.context, runId, "media_reserved", async () => ({
        value: null,
        stepId: step.id,
        payload: {},
      }));
      const dry = await importLegacyTextAttempts(t.db, { workspaceId });
      expect(dry.attempts).toMatchObject([
        { attemptId: step.id, action: "release-preparation", outcome: "non-dispatched" },
      ]);
      const apply = {
        workspaceId,
        apply: true,
        oldWritersDrained: true,
        auditId: "main-preflight",
      };
      expect((await importLegacyTextAttempts(t.db, apply)).attempts).toEqual(dry.attempts);
      expect((await importLegacyTextAttempts(t.db, { workspaceId })).attempts).toMatchObject([
        {
          attemptId: step.id,
          action: "already-imported",
          after: { reservedMinor: 0, grossMinor: 0, netMinor: 0 },
        },
      ]);
      expect((await importLegacyTextAttempts(t.db, apply)).attempts).toMatchObject([
        {
          attemptId: step.id,
          action: "already-imported",
          after: { reservedMinor: 0, grossMinor: 0, netMinor: 0 },
        },
      ]);
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        status: "RELEASED",
        committedMinor: null,
      });
      expect(await t.db.budgetEnvelope.findFirst({ where: { runId } })).toMatchObject({
        reservedMinor: 0,
        spentMinor: 0,
      });
      expect(await t.db.providerRequest.findMany({ where: { workspaceId } })).toMatchObject([
        { correlationId: step.id, errorCode: "NOT_DISPATCHED" },
      ]);
      expect(
        (
          await t.db.textAttemptEvidence.findMany({
            where: { workspaceId, attemptId: step.id },
            orderBy: { sequence: "asc" },
          })
        ).map(({ kind }) => kind),
      ).toEqual(["PREPARED", "NOT_DISPATCHED"]);
    },
  );

  it("links refunds on an unreserved routed estimate without hiding real later billing", async () => {
    const t = await fixture.tenant();
    const { workspaceId, channelId } = t.run;
    const correlationId = randomUUID();
    const posted = { ...artifact, checksumSha256: "a".repeat(64), billedSeconds: null };
    const port: VideoGenPort = {
      capabilities: () => ({
        ...catalog[0]!,
        modelId: "video-fixture",
        pricePerSecond: {
          ...catalog[0]!.pricePerSecond,
          "720p": 10000,
        },
      }),
      estimate: () => ({ currency: "USD", microUsd: 200000 }),
      submit: async () => ({ providerJobId: "unreserved-main-job" }),
      poll: async () => "succeeded",
      fetch: async () => posted,
    };
    const ledger = new ProviderLedger(t.db, t.usage);
    const mockPolicy = vi.spyOn(t.usage, "reservePaidCall").mockResolvedValue(null);
    const { providerJobId } = await ledger.submit(
      port,
      { ...shot, workspaceId },
      correlationId,
      channelId,
      correlationId,
      { lock: correlationId, correlations: [correlationId] },
    );
    mockPolicy.mockRestore();
    const where = { workspaceId, correlationId };
    const pending = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(pending.responseMetadata).toMatchObject({
      providerJobId,
      reservationId: null,
      estimateMinor: null,
    });
    // The deployed main finish wrote the estimate in both amount fields when seconds was unknown.
    const main = await t.db.providerRequest.update({
      where: { id: pending.id },
      data: {
        status: "SUCCEEDED",
        errorCode: null,
        actualCost: pending.estimatedCost,
        usage: { seconds: null },
        responseMetadata: {
          providerJobId,
          reservationId: null,
          estimateMinor: null,
          objectKey: posted.objectKey,
          checksumSha256: posted.checksumSha256,
        },
      },
    });
    await historicalCredit(t, { providerRequestId: main.id });
    await historicalCredit(t, { providerRequestId: main.id });
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
    const apply = { workspaceId, apply: true, oldWritersDrained: true, auditId: "main-unreserved" };
    expect((await importLegacyTextAttempts(t.db, apply)).mediaCreditLinks).toHaveLength(2);
    expect((await importLegacyTextAttempts(t.db, apply)).mediaCreditLinks).toEqual([]);
    expect(await t.db.usageReservation.count({ where })).toBe(0);
    expect(await t.db.providerRequest.findFirst({ where })).toMatchObject({
      actualCost: null,
      responseMetadata: { legacyEstimateMinor: 20 },
    });
    const totals = async (): Promise<
      { totalMinor: number; adjustmentNetMinor: number } | undefined
    > => (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0];
    expect(await totals()).toMatchObject({ totalMinor: 14, adjustmentNetMinor: 0 });
    await ledger.finish(
      workspaceId,
      correlationId,
      port,
      { ...posted, billedSeconds: 23 },
      providerJobId,
    );
    expect(await totals()).toMatchObject({ totalMinor: 23, adjustmentNetMinor: 0 });
  });
});
