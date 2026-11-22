import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AutonomyService } from "../autonomy/autonomy.service.js";
import { report } from "../autonomy/autonomy.fixture.js";
import type { Step } from "./runs.types.js";
import { completed, eightSecondShot, stagedClip } from "./runs.staged-clip.fixture.js";
import { runsFixture, type Tenant } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Gemini shot receipts and staged clips", () => {
  const fixture = runsFixture();

  it.each(["fetch storage failure", "missing stage", "corrupt stage"])(
    "retains the higher fetch charge and collects the accepted job after %s",
    async (cut) => {
      const { t, run, shot, job, fetcher, native } = await stagedClip(await fixture.tenant());
      fetcher
        .mockResolvedValueOnce(completed(8)) // poll
        .mockResolvedValueOnce(completed(10)) // fetch
        .mockResolvedValueOnce(completed(8)); // refetch of the same job
      if (cut === "fetch storage failure")
        vi.spyOn(t.storage, "putObject").mockRejectedValueOnce(new Error("storage offline"));
      else vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
      await expect(t.engine.process(job)).rejects.toThrow("storage offline");

      const checksumSha256 = createHash("sha256").update("clip").digest("hex");
      const staged = { workspaceId: run.workspaceId, objectKey: `providers/${checksumSha256}` };
      const where = { workspaceId: run.workspaceId, correlationId: shot.id };
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "WAITING_EXTERNAL",
        providerJobId: "accepted",
        output: {
          receipt: { costMinor: 70, seconds: 10 },
          pendingMedia: cut === "fetch storage failure" ? null : { objectKey: staged.objectKey },
        },
      });
      expect((await t.db.providerRequest.findFirstOrThrow({ where })).actualCost?.toNumber()).toBe(
        0.7,
      );
      expect((await t.db.usageReservation.findFirstOrThrow({ where })).amountMinor).toBe(70n);
      await expect(
        t.usage.reserve(run.workspaceId, {
          currency: "USD",
          category: "VIDEO_MEDIA",
          amountMinor: 14,
          idempotencyKey: "competing",
        }),
      ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      if (cut === "missing stage") await t.storage.deleteObject(staged);
      if (cut === "corrupt stage")
        await t.storage.putObject({
          ...staged,
          contentType: "video/mp4",
          body: Buffer.from("corrupt"),
        });

      await t.engine.process(job);
      await t.engine.process(job);
      expect(native.submit).toHaveBeenCalledOnce();
      expect(vi.mocked(native.fetch).mock.calls.map(([id]) => id)).toEqual([
        "accepted",
        "accepted",
      ]);
      expect(await t.storage.getObject(staged)).toEqual(Buffer.from("clip"));
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "SUCCEEDED",
        output: {
          storageArtifacts: [{ checksumSha256 }],
          receipt: { costMinor: 70, seconds: 10, providerDurationSeconds: 7 },
        },
      });
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({
        reservedMinor: 0,
        spentMinor: 70,
        overageMinor: 14,
      });
      expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
        { status: "COMMITTED", committedMinor: 70n },
      ]);
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: shot.id, type: "billing_reconciled" },
        }),
      ).toBe(1);
    },
  );

  async function expectSettled(
    t: Tenant,
    shot: Step,
    seconds: number,
    envelope = {
      spentMinor: seconds * 7,
      reservedMinor: 0,
      overageMinor: Math.max(0, seconds * 7 - 56),
    },
  ): Promise<void> {
    const where = { workspaceId: shot.workspaceId, correlationId: shot.id };
    const cost = seconds * 7;
    const requests = await t.db.providerRequest.findMany({ where });
    expect(requests).toMatchObject([{ status: "SUCCEEDED", errorCode: null }]);
    expect(requests[0]!.actualCost?.mul(100).toString()).toBe(String(cost));
    expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
      { status: "COMMITTED", committedMinor: BigInt(cost) },
    ]);
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: shot.runId } }),
    ).toMatchObject(envelope);
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "SUCCEEDED",
      providerJobId: "accepted",
      costMinor: cost,
      output: { receipt: { costBasis: "BILLED", seconds, costMinor: cost } },
    });
  }

  async function recoverBeforeLateFetch(
    { t, shot, job, fetcher }: Awaited<ReturnType<typeof stagedClip>>,
    recoveredSeconds: number,
    lateSeconds: number,
    beforeDelivery: () => Promise<void>,
  ): Promise<Step> {
    const started = Promise.withResolvers<void>();
    const lateFetch = Promise.withResolvers<Response>();
    fetcher
      .mockResolvedValueOnce(completed(recoveredSeconds))
      .mockImplementationOnce(() => {
        started.resolve();
        return lateFetch.promise;
      })
      .mockResolvedValueOnce(completed(recoveredSeconds));
    const original = t.engine.process(job);
    try {
      await Promise.race([
        started.promise,
        original.then(() => {
          throw new Error("Original worker finished before its fetch was gated");
        }),
      ]);
      await t.engine.process(job);
      const settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
      expect(settled.state).toBe("SUCCEEDED");
      await beforeDelivery();
      return settled;
    } finally {
      // Native fetch records the price first, then the collector delivers the priced descriptor.
      lateFetch.resolve(completed(lateSeconds, "late clip"));
      await original;
    }
  }

  async function admitSibling({
    t,
    run,
    fetcher,
  }: Awaited<ReturnType<typeof stagedClip>>): Promise<void> {
    const sibling = await eightSecondShot(t, run.id, 1);
    fetcher
      .mockResolvedValueOnce(Response.json({ status: "queued", id: "sibling" }))
      .mockResolvedValueOnce(Response.json({ status: "queued" }));
    expect(await t.engine.process(t.runs.job(t.context, run.id, sibling.id))).toBe(12000);
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      providerJobId: "sibling",
      costMinor: 56,
    });
  }

  it.each([
    { fps: 24, seconds: 12 },
    { fps: 30, seconds: 10 },
    { fps: 30, seconds: 12 },
  ])(
    "keeps the settled clip when the original fetch returns $fps fps and $seconds billed seconds",
    async ({ fps, seconds }) => {
      const f = await stagedClip(await fixture.tenant(), fps === 24 ? 84 : 200);
      const { t, run, shot, job, native, probe } = f;
      const put = vi.spyOn(t.artifacts, "put");
      const settled = await recoverBeforeLateFetch(f, 10, seconds, async () => {
        await expectSettled(t, shot, 10);
        expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
        probe.fps = fps;
      });
      await t.engine.process(job);
      await expectSettled(t, shot, seconds);
      const corrected = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
      expect(corrected.finishedAt).toEqual(settled.finishedAt);
      expect(t.artifacts.descriptors(corrected.output)).toEqual(
        t.artifacts.descriptors(settled.output),
      );
      const events = await t.db.runEvent.findMany({ where: { runId: run.id, stepId: shot.id } });
      expect(events.filter((e) => e.type === "billing_reconciled")).toHaveLength(1);
      const adjustments = events.filter(
        (e) =>
          e.type === "provider_receipt" &&
          e.payload &&
          typeof e.payload === "object" &&
          "adjustmentMinor" in e.payload,
      );
      expect(adjustments).toMatchObject(
        seconds === 12 ? [{ payload: { adjustmentMinor: 14, costMinor: 84 } }] : [],
      );
      expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(
        seconds * 7,
      );
      expect(put).toHaveBeenCalledOnce();
      expect(native.submit).toHaveBeenCalledOnce();
      if (fps === 30) {
        expect(await t.store.get(t.context, run.id)).toMatchObject({
          state: "GENERATING",
          pauseReason: null,
        });
        await admitSibling(f);
      } else {
        await expect(
          t.usage.reserve(run.workspaceId, {
            currency: "USD",
            category: "VIDEO_MEDIA",
            amountMinor: 14,
            idempotencyKey: "competing",
          }),
        ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      }
    },
  );

  it("commits the full late receipt after a sibling reserves the released headroom", async () => {
    const f = await stagedClip(await fixture.tenant(), 400);
    const { t, run, shot, job, native } = f;
    const put = vi.spyOn(t.artifacts, "put");
    const where = { runId: run.id };
    await t.db.budgetEnvelope.updateMany({
      where,
      data: {
        targetMinor: 400,
        hardCapMinor: 400,
        baseEstimateMinor: 400,
        reshootReserveMinor: 0,
        spentMinor: 302,
      },
    });
    const settled = await recoverBeforeLateFetch(f, 6, 8, async () => {
      await expectSettled(t, shot, 6, { spentMinor: 344, reservedMinor: 0, overageMinor: 0 });
      await admitSibling(f);
      expect(await t.db.budgetEnvelope.findFirstOrThrow({ where })).toMatchObject({
        spentMinor: 344,
        reservedMinor: 56,
        overageMinor: 0,
      });
    });
    await t.engine.process(job);
    await expectSettled(t, shot, 8, { spentMinor: 358, reservedMinor: 56, overageMinor: 14 });
    expect(put).toHaveBeenCalledOnce();
    const corrected = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(corrected.finishedAt).toEqual(settled.finishedAt);
    expect(t.artifacts.descriptors(corrected.output)).toEqual(
      t.artifacts.descriptors(settled.output),
    );
    const events = await t.db.runEvent.findMany({ where: { ...where, stepId: shot.id } });
    expect(events.filter((e) => e.type === "step_completed")).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.type === "provider_receipt" &&
          e.payload &&
          typeof e.payload === "object" &&
          "adjustmentMinor" in e.payload,
      ),
    ).toMatchObject([{ payload: { previousCostMinor: 42, adjustmentMinor: 14, costMinor: 56 } }]);
    const next = await eightSecondShot(t, run.id, 2);
    await expect(t.engine.process(t.runs.job(t.context, run.id, next.id))).rejects.toThrow(
      "Envelope exhausted",
    );
    expect(native.submit).toHaveBeenCalledTimes(2);
  });

  it.each(["L2", "L3"] as const)(
    "rechecks a passing critic budget after a settled correction at %s",
    async (level) => {
      const f = await stagedClip(await fixture.tenant(), 84);
      const { t, shot, run } = f;
      const where = { runId: run.id };
      await t.db.budgetEnvelope.updateMany({
        where,
        data: { baseEstimateMinor: 70, reshootReserveMinor: 7 },
      });
      await recoverBeforeLateFetch(f, 10, 12, async () => {
        await expectSettled(t, shot, 10);
        await t.db.videoRunStep.create({
          data: {
            ...where,
            workspaceId: run.workspaceId,
            key: "CRITIC",
            attempt: 1,
            idempotencyKey: run.id + ":CRITIC:1",
            state: "SUCCEEDED",
            input: {},
            output: { result: report },
          },
        });
        await t.db.videoRun.update({
          where: { id: run.id },
          data: {
            state: "AWAITING_APPROVAL",
            effectiveAutonomy: level,
            approvedShortsAtStart: 10,
          },
        });
      });
      const autonomy = new AutonomyService(t.store, {
        check: async (): Promise<typeof t.stop> => t.stop,
      });
      if (level === "L2")
        await expect(autonomy.decide(t.context, run.id, "APPROVE")).rejects.toThrow("hard gates");
      else {
        await autonomy.settle(t.context, await t.store.get(t.context, run.id));
        expect(await t.db.runEvent.count({ where: { ...where, type: "autonomy_fallback" } })).toBe(
          1,
        );
      }
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "AWAITING_APPROVAL",
        effectiveAutonomy: "L2",
      });
      expect(
        await t.db.runEvent.count({
          where: { ...where, type: { in: ["approved", "auto_approved"] } },
        }),
      ).toBe(0);
      await expectSettled(t, shot, 12);
      const envelope = await t.db.budgetEnvelope.findFirstOrThrow({ where });
      expect(envelope.spentMinor).toBeGreaterThan(
        envelope.baseEstimateMinor + envelope.reshootReserveMinor,
      );
      expect(envelope.spentMinor).toBeLessThan(envelope.hardCapMinor);
    },
  );

  it.each(["poll", "staging repair"])(
    "uses the six billed seconds from %s for an eight-second request",
    async (source) => {
      const { t, shot, job, fetcher, native } = await stagedClip(await fixture.tenant());
      fetcher
        .mockResolvedValueOnce(completed(source === "poll" ? 6 : undefined))
        .mockResolvedValueOnce(completed());
      if (source === "staging repair") {
        vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
        await expect(t.engine.process(job)).rejects.toThrow("storage offline");
        const staged = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
        expect(staged.output).toMatchObject({
          receipt: { costBasis: "RESERVATION", costMinor: 56 },
        });
        await t.storage.deleteObject({
          workspaceId: shot.workspaceId,
          objectKey: `providers/${createHash("sha256").update("clip").digest("hex")}`,
        });
        fetcher.mockResolvedValueOnce(completed(6));
      }
      await t.engine.process(job);
      await t.engine.process(job);
      await expectSettled(t, shot, 6);
      expect(native.submit).toHaveBeenCalledOnce();
    },
  );

  it("keeps the valid descriptor and higher liability across an invalid replacement", async () => {
    const { t, shot, job, fetcher, probe, native } = await stagedClip(await fixture.tenant(), 84);
    fetcher
      .mockResolvedValueOnce(completed(8))
      .mockResolvedValueOnce(completed(10))
      .mockResolvedValueOnce(completed(12, "30fps"))
      .mockResolvedValueOnce(completed(8, "24fps"));
    const put = vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
    await expect(t.engine.process(job)).rejects.toThrow("storage offline");
    const objectKey = `providers/${createHash("sha256").update("clip").digest("hex")}`;
    await t.storage.deleteObject({ workspaceId: shot.workspaceId, objectKey });
    probe.fps = 30;
    await expect(t.engine.process(job)).rejects.toThrow("invalid 720p video");
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      output: {
        pendingMedia: { objectKey, fps: 24 },
        receipt: { costMinor: 84, seconds: 12 },
      },
    });
    expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(84);
    expect(put).toHaveBeenCalledTimes(1);
    probe.fps = 24;
    await t.engine.process(job);
    await t.engine.process(job);
    await expectSettled(t, shot, 12);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![2]).toEqual(Buffer.from("24fps"));
    expect(vi.mocked(native.fetch).mock.calls.map(([id]) => id)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(native.submit).toHaveBeenCalledOnce();
    expect(
      await t.db.runEvent.count({ where: { stepId: shot.id, type: "billing_reconciled" } }),
    ).toBe(1);
  });
});
