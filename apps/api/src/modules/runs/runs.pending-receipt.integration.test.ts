import { reservationCents } from "@reelforge/ai-providers";
import { ShotSpecSchema } from "@reelforge/contracts";
import { z } from "zod";
import { report } from "../autonomy/autonomy.fixture.js";
import { fixtureShots } from "../scene-media/media-provider.fixture.js";
import { maximumClipMoney } from "../scene-media/media-prices.js";
import { captureShotReceipt } from "../usage-budget/run-billing.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { persistPendingCorrection } from "../usage-budget/run-pending-receipt.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { json, type Step } from "./runs.types.js";
import {
  downgradeToLegacyAdmission,
  generating,
  runsFixture,
  type Tenant,
} from "./runs.fixture.js";
import { expectCompetingImageDenied, stagedClip } from "./runs.staged-clip.fixture.js";
import { describe, expect, it, vi } from "vitest";

function pricedClip(seconds = 10): VideoReceipt {
  return {
    costBasis: "BILLED",
    costMinor: seconds * 7,
    seconds,
    providerDurationSeconds: seconds,
    modelId: "fixture-video",
    promptVersion: "fixture",
    media: {
      objectKey: "provider-clip",
      checksumSha256: "a".repeat(64),
      byteSize: 16,
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      fps: 24,
      billedSeconds: seconds,
      durationSeconds: seconds,
    },
  };
}

async function settleInitialClip(f: Awaited<ReturnType<typeof stagedClip>>): Promise<Step> {
  f.fetcher.mockResolvedValueOnce(f.wire.completed(10)).mockResolvedValueOnce(f.wire.completed(10));
  await f.t.engine.process(f.job);
  return f.t.db.videoRunStep.findUniqueOrThrow({ where: { id: f.shot.id } });
}

async function installPendingCorrection(t: Tenant, shot: Step): Promise<void> {
  await t.db.videoRunStep.update({
    where: { id: shot.id },
    data: {
      state: "SUCCEEDED",
      providerId: "fixture-provider",
      providerJobId: "accepted",
      costMinor: 70,
    },
  });
  const current = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
  await persistPendingCorrection(t.store, t.context, current, pricedClip(12));
}

describe.skipIf(!process.env.DATABASE_URL)("pending receipt correction", () => {
  const fixture = runsFixture();

  it.each(["open", "settled"] as const)(
    "protects a competing admission while a higher %s receipt correction times out",
    async (state): Promise<void> => {
      const f = await stagedClip(await fixture.tenant(), 400);
      const { t, run, shot, job, fetcher, wire } = f;
      let original: Promise<number | null> | undefined;
      let releaseFetch: (() => void) | undefined;
      if (state === "open") {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<Response>();
        releaseFetch = (): void => release.resolve(wire.completed(10));
        fetcher.mockResolvedValueOnce(wire.completed(10)).mockImplementationOnce(() => {
          started.resolve();
          return release.promise;
        });
        original = t.engine.process(job);
        await started.promise;
      } else {
        expect((await settleInitialClip(f)).state).toBe("SUCCEEDED");
      }

      await downgradeToLegacyAdmission(t, run, shot);
      const current = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
      const output = z.record(z.string(), z.unknown()).parse(current.output);
      await t.db.videoRunStep.update({
        where: { id: shot.id },
        data: {
          output: {
            ...output,
            receiptBudget: { admittedMinor: 70, bufferMinor: 0, estimateMinor: 56 },
          },
        },
      });
      if (state === "settled")
        await t.db.budgetEnvelope.updateMany({
          where: { runId: run.id },
          data: { reservedMinor: 0 },
        });
      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        monthlyLimitMinor: 84,
        reason: "pending receipt race",
      });

      const observed = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
      await persistPendingCorrection(t.store, t.context, observed, pricedClip(12));
      const timeout = Object.assign(new Error("Transaction timeout"), { code: "P2028" });
      const entered = Promise.withResolvers<void>();
      const releaseCorrection = Promise.withResolvers<void>();
      vi.spyOn(t.usage, "coverShotReceipt").mockImplementationOnce(async () => {
        entered.resolve();
        await releaseCorrection.promise;
        throw timeout;
      });
      const failed = captureShotReceipt(
        t.store,
        new RunPaidCalls(t.usage, t.store),
        t.context,
        observed,
        pricedClip(12),
      );
      try {
        await entered.promise;
        await expectCompetingImageDenied(t);
      } finally {
        releaseCorrection.resolve();
      }
      await expect(failed).rejects.toBe(timeout);
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        error: { code: "PENDING_RECEIPT_CORRECTION", costMinor: 84 },
      });
      await expectCompetingImageDenied(t);

      if (state === "open") {
        releaseFetch!();
        await expect(original).rejects.toThrow("RECONCILE_REQUIRED");
        expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject(
          {
            state: "WAITING_EXTERNAL",
            error: { code: "VIDEO_RUN_BILLING_OVERAGE" },
          },
        );
        expect(await t.store.get(t.context, run.id)).toMatchObject({
          state: "GENERATING",
          pauseReason: expect.stringContaining("RECONCILE_REQUIRED"),
        });
        await t.engine.process(job);
        expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject(
          {
            state: "SUCCEEDED",
            costMinor: 84,
          },
        );
      } else {
        const winner = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
        await t.engine.process(job);
        const settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
        expect(settled).toMatchObject({
          state: "SUCCEEDED",
          costMinor: 84,
          finishedAt: winner.finishedAt,
        });
        expect(t.artifacts.descriptors(settled.output)).toEqual(
          t.artifacts.descriptors(winner.output),
        );
      }

      expect(
        await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
      ).toMatchObject({ status: "COMMITTED", committedMinor: 84n });
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: shot.id, type: "step_completed" },
        }),
      ).toBe(state === "settled" ? 1 : 0);
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: shot.id, type: "billing_reconciled" },
        }),
      ).toBe(state === "open" ? 1 : 0);
      expect(await t.usage.listBudgets(t.context)).toMatchObject([
        { periods: [{ consumedMinor: 84 }] },
      ]);
    },
  );

  it("holds assembly-to-critic advancement while a receipt correction is pending", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
    const shot = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    await installPendingCorrection(t, shot);

    expect(await t.runs.move(t.context, await t.store.get(t.context, run.id), "CRITIC")).toBe(
      false,
    );
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "ASSEMBLING",
      pauseReason: expect.stringContaining("RECONCILE_REQUIRED"),
    });
  });

  it("blocks final approval while a settled receipt correction is pending", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key: "CRITIC",
        attempt: 1,
        idempotencyKey: `${run.id}:CRITIC:1`,
        state: "SUCCEEDED",
        input: {},
        output: { result: report },
      },
    });
    await t.db.videoRun.update({
      where: { id: run.id },
      data: { state: "AWAITING_APPROVAL" },
    });
    const shot = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    await installPendingCorrection(t, shot);

    await expect(t.control.approve(t.context, run.id)).rejects.toThrow(
      "Approval is blocked during billing reconciliation",
    );
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "AWAITING_APPROVAL",
    });
    expect(
      await t.db.runEvent.count({
        where: { runId: run.id, type: { in: ["approved", "auto_approved"] } },
      }),
    ).toBe(0);
  });

  it("fits three maximum-liability shots and mandatory work at the exact minimum cap", async () => {
    const t = await fixture.tenant("L2", 30, null, false);
    const run = await t.store.get(t.context, t.run.id);
    const specs = fixtureShots(run, t.brief)
      .slice(0, 3)
      .map((shot, ordinal) => ShotSpecSchema.parse({ ...shot, ordinal, durationSeconds: 10 }));
    await t.db.shotSpec.createMany({
      data: specs.map((spec) => ({
        id: spec.id,
        workspaceId: run.workspaceId,
        runId: run.id,
        ordinal: spec.ordinal,
        version: spec.version,
        document: spec,
      })),
    });

    const snapshot = z.record(z.string(), z.unknown()).parse(run.inputSnapshot);
    const brief = z.record(z.string(), z.unknown()).parse(snapshot.brief);
    const policy = z.record(z.string(), z.unknown()).parse(brief.budgetPolicy);
    await t.db.videoRun.update({
      where: { id: run.id },
      data: {
        inputSnapshot: json({
          ...snapshot,
          brief: { ...brief, budgetPolicy: { ...policy, targetMinor: 428, hardCapMinor: 428 } },
        }),
      },
    });
    const constrainedRun = await t.store.get(t.context, run.id);
    await t.planning.prepare(t.context, constrainedRun);

    const envelope = await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    const maximumShotLiability = specs.reduce(
      (total, shot) => total + reservationCents(maximumClipMoney(shot, false)),
      0,
    );
    expect(maximumShotLiability).toBe(315);
    expect(envelope).toMatchObject({
      targetMinor: 428,
      hardCapMinor: 428,
      baseEstimateMinor: 428,
      reshootReserveMinor: 0,
      spentMinor: 0,
      reservedMinor: 0,
    });
    expect(envelope.baseEstimateMinor - maximumShotLiability).toBe(113);
  });
});
