import { setTimeout as delay } from "node:timers/promises";
import { ShotSpecSchema } from "@reelforge/contracts";
import { z } from "zod";
import { pricedClip } from "./runs.receipt-recovery.fixture.js";
import { report } from "../autonomy/autonomy.fixture.js";
import { captureShotReceipt } from "../usage-budget/run-billing.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { persistPendingCorrection } from "../usage-budget/run-pending-receipt.js";
import type { Step } from "./runs.types.js";
import { generating, runsFixture, type Tenant } from "./runs.fixture.js";
import { expectCompetingImageDenied, stagedClip } from "./runs.staged-clip.fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => vi.unstubAllEnvs());

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

  it.each(["expired pre-buffer", "within the buffer"] as const)(
    "keeps the first 84-cent fetch across a real budget row timeout (%s) and a 70-cent replay",
    async (kind) => {
      const legacy = kind === "expired pre-buffer";
      const { t, shot, job, run, fetcher, wire, native } = await stagedClip(
        await fixture.tenant(),
        legacy ? 84 : 88,
      );
      if (!legacy)
        await t.db.videoRunStep.update({
          where: { id: shot.id },
          data: { input: { ...ShotSpecSchema.parse(shot.input), durationSeconds: 10 } },
        });
      const atFetch = Promise.withResolvers<void>();
      const fetched = Promise.withResolvers<Response>();
      fetcher
        .mockResolvedValueOnce(legacy ? wire.completed(10) : Response.json({ status: "completed" }))
        .mockImplementationOnce(() => {
          atFetch.resolve();
          return fetched.promise;
        });
      const worker = t.engine.process(job);
      await Promise.race([atFetch.promise, worker]);
      const where = { workspaceId: run.workspaceId, correlationId: shot.id };
      const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
      if (legacy) {
        const current = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
        const old = z.object({ pendingMedia: z.null(), receipt: z.json() }).parse(current.output);
        await t.db.videoRunStep.update({ where: { id: shot.id }, data: { output: old } });
        await t.usage.sweepExpiredReservations(new Date(Date.now() + 86400001), run.workspaceId);
        expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
          status: "EXPIRED",
        });
        expect(
          (await t.db.providerRequest.findFirstOrThrow({ where })).actualCost?.toNumber(),
        ).toBe(0.7);
      }
      const cover = t.usage.coverShotReceipt.bind(t.usage);
      const entering = Promise.withResolvers<void>();
      vi.spyOn(t.usage, "coverShotReceipt").mockImplementationOnce((...args) => {
        entering.resolve();
        return cover(...args);
      });
      const timedOut = expect(worker).rejects.toMatchObject({ code: "P2028" });
      await t.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM usage_budgets WHERE workspace_id = ${run.workspaceId}::uuid FOR UPDATE`;
          fetched.resolve(wire.completed(12));
          await Promise.race([entering.promise, worker]);
          expect(
            await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } }),
          ).toMatchObject({
            error: { code: "PENDING_RECEIPT_CORRECTION", costMinor: 84 },
          });
          // Hold the row through Prisma's default five-second interactive transaction deadline.
          await delay(5300);
        },
        { timeout: 15000 },
      );
      await timedOut;
      expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(
        legacy ? 84 : 88,
      );
      await expectCompetingImageDenied(t);
      fetcher.mockResolvedValueOnce(wire.completed(10));
      await t.engine.process(job);
      await t.engine.process(job);
      expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
        {
          id: reservation.id,
          createdAt: reservation.createdAt,
          status: "COMMITTED",
          committedMinor: 84n,
        },
      ]);
      expect((await t.db.providerRequest.findFirstOrThrow({ where })).actualCost?.toNumber()).toBe(
        0.84,
      );
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "SUCCEEDED",
        costMinor: 84,
        error: null,
      });
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "GENERATING",
        pauseReason: null,
      });
      expect(native.submit).toHaveBeenCalledOnce();
    },
    30000,
  );

  it("settles a second overage against the saved clip and replays without another fetch", async () => {
    const { t, run, shot, job, fetcher, wire, native } = await stagedClip(await fixture.tenant());
    fetcher.mockResolvedValueOnce(wire.completed(10)).mockResolvedValueOnce(wire.completed(12));
    await expect(t.engine.process(job)).rejects.toThrow("billing exceeded");
    const delivered = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    const artifacts = t.artifacts.descriptors(delivered.output);
    expect(artifacts).toMatchObject([{ kind: "clips" }]);
    expect(delivered).toMatchObject({
      state: "WAITING_EXTERNAL",
      output: { receipt: { costMinor: 84 } },
    });
    await persistPendingCorrection(t.store, t.context, delivered, pricedClip(13));
    await t.engine.process(job);
    await t.engine.process(job);
    const final = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(t.artifacts.descriptors(final.output)).toEqual(artifacts);
    expect(final).toMatchObject({
      state: "SUCCEEDED",
      costMinor: 91,
      error: null,
      output: { receipt: { costMinor: 91 } },
    });
    expect(
      await t.db.usageReservation.findMany({ where: { correlationId: shot.id } }),
    ).toMatchObject([{ status: "COMMITTED", committedMinor: 91n }]);
    expect(
      (
        await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: shot.id } })
      ).actualCost?.toNumber(),
    ).toBe(0.91);
    expect(
      await t.db.runEvent.count({
        where: { runId: run.id, stepId: shot.id, type: "billing_reconciled" },
      }),
    ).toBe(1);
    expect(native.submit).toHaveBeenCalledOnce();
    expect(native.fetch).toHaveBeenCalledOnce();
  });

  it.each([null, "MEDIA_TOOL_UNAVAILABLE"] as const)(
    "holds assembly-to-critic advancement for a pending receipt correction (existing pause: %s)",
    async (pauseReason) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const shot = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      await installPendingCorrection(t, shot);
      await t.db.videoRun.update({
        where: { id: run.id },
        data: { state: "ASSEMBLING", pauseReason },
      });

      expect(await t.runs.move(t.context, await t.store.get(t.context, run.id), "CRITIC")).toBe(
        false,
      );
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "ASSEMBLING",
        pauseReason: pauseReason ?? expect.stringContaining("RECONCILE_REQUIRED"),
      });
    },
  );

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
});
