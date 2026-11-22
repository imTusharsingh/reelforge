import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AutonomyService } from "../autonomy/autonomy.service.js";
import { report } from "../autonomy/autonomy.fixture.js";
import {
  admitSibling,
  expectSettled,
  clipFailures,
  lateClipCases,
  clipUri,
  completed,
  failingClip,
  eightSecondShot,
  stagedClip,
  recoverBeforeLateFetch,
  postEditorApproval,
} from "./runs.staged-clip.fixture.js";
import { runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Shot receipts and staged clips", () => {
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

  it.each(lateClipCases)(
    "keeps the settled clip after a late $kind response from $provider with $seconds billed seconds",
    async ({ provider, kind, seconds, pause }) => {
      const f = await stagedClip(await fixture.tenant(), kind === "valid" ? 84 : 400, provider);
      const { t, run, shot, job, native } = f;
      const put = vi.spyOn(t.artifacts, "put");
      const recoveredSeconds = kind === "job GET 503" ? seconds : 10;
      const settled = await recoverBeforeLateFetch(
        f,
        recoveredSeconds,
        seconds,
        async () => {
          await expectSettled(f, recoveredSeconds);
          expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
          if (kind !== "valid") return failingClip(f, kind, seconds);
        },
        10,
      );
      await t.engine.process(job);
      await expectSettled(f, seconds);
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
        seconds > recoveredSeconds ? [{ payload: { adjustmentMinor: 14, costMinor: 84 } }] : [],
      );
      expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(
        seconds * f.wire.centsPerSecond,
      );
      expect(put).toHaveBeenCalledOnce();
      expect(native.submit).toHaveBeenCalledOnce();
      if (kind !== "valid") {
        if (kind !== "job GET 503")
          expect(f.fetcher).toHaveBeenLastCalledWith(clipUri, expect.anything());
        expect(events.filter((e) => e.type === "redundant_clip_discarded")).toMatchObject([
          { payload: { reason: pause } },
        ]);
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

  it("ignores a billing callback failure after recovery settled the clip", async () => {
    const f = await stagedClip(await fixture.tenant(), 200);
    const error = new Error("charge correction failed");
    await expect(
      recoverBeforeLateFetch(f, 10, 12, async () => {
        vi.spyOn(f.t.usage, "coverShotReceipt").mockRejectedValueOnce(error);
      }),
    ).resolves.toMatchObject({ state: "SUCCEEDED" });
    await expectSettled(f, 10);
    expect(await f.t.store.get(f.t.context, f.run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
  });

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
      await expectSettled(f, 6, { spentMinor: 344, reservedMinor: 0, overageMinor: 0 });
      await admitSibling(f);
      expect(await t.db.budgetEnvelope.findFirstOrThrow({ where })).toMatchObject({
        spentMinor: 344,
        reservedMinor: 56,
        overageMinor: 0,
      });
    });
    await t.engine.process(job);
    await expectSettled(f, 8, { spentMinor: 358, reservedMinor: 56, overageMinor: 14 });
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
      const { t, run } = f;
      const where = { runId: run.id };
      await t.db.budgetEnvelope.updateMany({
        where,
        data: { baseEstimateMinor: 70, reshootReserveMinor: 7 },
      });
      await recoverBeforeLateFetch(f, 10, 12, async () => {
        await expectSettled(f, 10);
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
      const response = await postEditorApproval(t);
      expect(response.status).toBe(409);
      expect(response.body.message).toContain("hard gates");
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "AWAITING_APPROVAL",
        effectiveAutonomy: "L2",
      });
      expect(
        await t.db.runEvent.count({
          where: { ...where, type: { in: ["approved", "auto_approved"] } },
        }),
      ).toBe(0);
      await expectSettled(f, 12);
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
      const f = await stagedClip(await fixture.tenant());
      const { t, shot, job, fetcher, native } = f;
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
      await expectSettled(f, 6);
      expect(native.submit).toHaveBeenCalledOnce();
    },
  );

  it.each(clipFailures)(
    "surfaces $provider $kind and recovers the unfinished job at its recorded price",
    async ({ provider, kind, message, pause }) => {
      const f = await stagedClip(await fixture.tenant(), 200, provider);
      const { t, shot, job, fetcher, probe, native, wire } = f;
      const recordedSeconds = kind === "job GET 503" ? 6 : 8;
      fetcher
        .mockResolvedValueOnce(wire.completed(6))
        .mockImplementationOnce(async () => failingClip(f, kind, 8));
      await expect(t.engine.process(job)).rejects.toThrow(message);
      expect(await t.store.get(t.context, shot.runId)).toMatchObject({
        state: "PAUSED_BUDGET",
        pauseReason: pause,
      });
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "WAITING_EXTERNAL",
        providerJobId: "accepted",
        output: {
          receipt: { costMinor: recordedSeconds * wire.centsPerSecond, seconds: recordedSeconds },
        },
      });
      if (kind === "job GET 503")
        expect(fetcher).toHaveBeenLastCalledWith(
          wire.jobUrl,
          expect.objectContaining({ method: "GET" }),
        );
      probe.exitCode = 0;
      probe.fps = 24;
      fetcher.mockResolvedValueOnce(wire.completed(6));
      await t.engine.process(job);
      await expectSettled(f, recordedSeconds);
      expect(native.submit).toHaveBeenCalledOnce();
    },
  );

  it("keeps the valid descriptor and higher liability across an invalid replacement", async () => {
    const f = await stagedClip(await fixture.tenant(), 84);
    const { t, shot, job, fetcher, probe, native } = f;
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
    await expectSettled(f, 12);
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
