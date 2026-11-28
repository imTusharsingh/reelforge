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
    "releases a drained main preflight with a migrated %s reservation and no dispatch marker",
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
      // The migration runs before cutover; the linked main VIDEO_MEDIA row is now LLM.
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        status,
        category: "LLM",
        idempotencyKey: `m08:${step.idempotencyKey}`,
      });
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

  it.each([false, true])(
    "links unreserved routed refunds without hiding verified billing (bill arrived first: %s)",
    async (billFirst) => {
      const t = await fixture.tenant();
      const { workspaceId, channelId } = t.run;
      const correlationId = randomUUID();
      const posted = { ...artifact, checksumSha256: "a".repeat(64), billedSeconds: null };
      const port: VideoGenPort = {
        capabilities: () => ({
          ...catalog[0]!,
          modelId: "veo-3",
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
          actualCost: billFirst ? "0.23" : pending.estimatedCost,
          usage: { seconds: billFirst ? 23 : null },
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
      const apply = {
        workspaceId,
        apply: true,
        oldWritersDrained: true,
        auditId: "main-unreserved",
      };
      expect((await importLegacyTextAttempts(t.db, apply)).mediaCreditLinks).toHaveLength(2);
      expect((await importLegacyTextAttempts(t.db, apply)).mediaCreditLinks).toEqual([]);
      expect(await t.db.usageReservation.count({ where })).toBe(0);
      const total = async (): Promise<
        { totalMinor: number; adjustmentNetMinor: number } | undefined
      > => (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0];
      const current = await t.db.providerRequest.findFirstOrThrow({ where });
      if (billFirst) {
        expect(current.actualCost?.toString()).toBe("0.23");
        expect(current.usage).toEqual({ seconds: 23 });
        expect(current.responseMetadata).toEqual(main.responseMetadata);
      } else {
        expect(current).toMatchObject({
          actualCost: null,
          responseMetadata: { legacyEstimateMinor: 20 },
        });
        expect(await total()).toMatchObject({ totalMinor: 14, adjustmentNetMinor: 0 });
        await ledger.finish(
          workspaceId,
          correlationId,
          port,
          { ...posted, billedSeconds: 23 },
          providerJobId,
        );
      }
      expect(
        await t.db.usageAdjustment.count({ where: { workspaceId, providerRequestId: main.id } }),
      ).toBe(2);
      expect(await total()).toMatchObject({ totalMinor: 23, adjustmentNetMinor: 0 });
    },
  );
});
