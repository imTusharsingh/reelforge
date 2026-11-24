import { z } from "zod";
import { json, type Step } from "./runs.types.js";
import { describe, expect, it, vi } from "vitest";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { generateClips, generating, runsFixture } from "./runs.fixture.js";
import {
  admitSibling,
  completed,
  downgradeToLegacyAdmission,
  eightSecondShot,
  expectSettled,
  recoverBeforeLateFetch,
  stagedClip,
} from "./runs.staged-clip.fixture.js";
import type { RunsQueue } from "./runs.queue.js";

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
describe.skipIf(!process.env.DATABASE_URL)("shot receipt recovery", () => {
  const fixture = runsFixture();
  it("ignores P2028 artifact attachment after recovery settled the clip", async () => {
    const f = await stagedClip(await fixture.tenant(), 200);
    const { t, run, shot, job, fetcher } = f;
    fetcher.mockResolvedValueOnce(completed(10)).mockResolvedValueOnce(completed(10));
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = t.artifacts.put.bind(t.artifacts);
    vi.spyOn(t.artifacts, "put").mockImplementationOnce(async (...args) => {
      const artifact = await put(...args);
      written.resolve();
      await release.promise;
      return artifact;
    });
    const original = t.engine.process(job);
    const saved = (): Promise<Step> =>
      t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    await Promise.race([
      written.promise,
      original.then(() => {
        throw new Error("Clip was not gated");
      }),
    ]);
    const p2028 = Object.assign(new Error("Transaction timeout"), { code: "P2028" });
    const failReplay = vi.fn(() => {
      throw p2028;
    });
    let winner: Step;
    try {
      expect(await saved()).toMatchObject({
        state: "WAITING_EXTERNAL",
        output: { receipt: { costMinor: 70 } },
      });
      await t.engine.process(job);
      winner = await saved();
      expect(winner).toMatchObject({ state: "SUCCEEDED", finishedAt: expect.any(Date) });
      const mutate = t.store.mutate.bind(t.store);
      vi.spyOn(t.store, "mutate").mockImplementation((context, id, type, work) =>
        mutate(context, id, type, async (db, current, tx) => {
          const result = await work(db, current, tx);
          if (type === "step_completed") {
            expect(result.payload).toEqual({ replay: true });
            failReplay();
          }
          return result;
        }),
      );
    } finally {
      release.resolve();
      await expect(original).resolves.toBeNull();
    }
    expect(failReplay).toHaveBeenCalledOnce();
    expect(await saved()).toEqual(winner);
    await expectSettled(f, 10);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
    await admitSibling(f);
  });

  it("denies an otherwise affordable sibling at the cap while the settled receipt buffer is held", async () => {
    const f = await stagedClip(await fixture.tenant(), 400);
    const { t, run, native } = f;
    await t.db.budgetEnvelope.updateMany({
      where: { runId: run.id },
      data: {
        targetMinor: 372,
        hardCapMinor: 372,
        baseEstimateMinor: 372,
        reshootReserveMinor: 0,
        spentMinor: 267,
      },
    });
    await recoverBeforeLateFetch(f, 6, 12, async () => {
      await expectSettled(f, 6, { spentMinor: 309, reservedMinor: 63, overageMinor: 0 }, 105);
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "GENERATING",
        pauseReason: null,
      });
      const sibling = await eightSecondShot(t, run.id, 1);
      // The provider maximum charge cannot fit while the original receipt's coverage is held.
      vi.spyOn(t.generation.provider, "estimate").mockReturnValueOnce(20);
      await expect(t.engine.process(t.runs.job(t.context, run.id, sibling.id))).rejects.toThrow(
        "Envelope exhausted",
      );
      expect(
        await t.db.videoRunStep.findUniqueOrThrow({ where: { id: sibling.id } }),
      ).toMatchObject({ state: "PENDING", providerJobId: null });
      expect(await t.db.usageReservation.count({ where: { correlationId: sibling.id } })).toBe(0);
    });
    await expectSettled(f, 12, { spentMinor: 351, reservedMinor: 21, overageMinor: 0 }, 105);
    expect(native.submit).toHaveBeenCalledOnce();
  });

  it("corrects a pre-buffer settlement without consuming another reservation's headroom", async () => {
    const f = await stagedClip(await fixture.tenant(), 200);
    const { t, run, shot } = f;
    const where = { correlationId: shot.id, workspaceId: run.workspaceId };
    await recoverBeforeLateFetch(f, 6, 12, async () => {
      const saved = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
      const old = z
        .object({ receipt: z.json(), storageArtifacts: z.array(z.json()) })
        .parse(saved.output);
      await t.db.$transaction([
        t.db.videoRunStep.update({ where: { id: shot.id }, data: { output: json(old) } }),
        t.db.budgetEnvelope.updateMany({ where: { runId: run.id }, data: { reservedMinor: 0 } }),
        t.db.providerRequest.updateMany({ where, data: { estimatedCost: 0.56 } }),
        t.db.usageReservation.updateMany({ where, data: { amountMinor: 56n } }),
      ]);
      expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(42);
      await admitSibling(f);
    });
    await expectSettled(f, 12, { spentMinor: 84, reservedMinor: 105, overageMinor: 28 }, 189);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
  });

  it.each([
    "missing request",
    "swept missing request",
    "artifact write",
    "native storage",
    "emergency stop",
    "legacy hold before stop",
  ])("reconciles an older underestimated liability across %s", async (cut) => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const [shot, pending] = await t.db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const job = t.runs.job(t.context, run.id, shot!.id);
    const collectReceipt = vi.fn(async () => pricedClip(12));
    const port = Object.assign(t.generation.provider, { collectReceipt });
    const submit = vi.spyOn(port, "submit");
    const poll = vi.spyOn(port, "poll").mockResolvedValueOnce("running");
    vi.spyOn(port, "estimate").mockReturnValue(56);
    await t.usage.upsertBudget(t.context, {
      currency: "USD",
      monthlyLimitMinor: 105,
      reason: "overage test",
    });
    await expect(t.engine.process(job)).resolves.toBe(12000);
    const where = { workspaceId: run.workspaceId, correlationId: shot!.id };
    await downgradeToLegacyAdmission(t, run, shot!);
    const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
    expect(reservation.amountMinor).toBe(70n);
    const enqueue = vi.fn<RunsQueue["enqueue"]>();
    t.runs.queue = { enqueue, fanout: vi.fn() } as unknown as RunsQueue;
    if (cut.endsWith("missing request")) await t.db.providerRequest.deleteMany({ where });
    if (cut === "swept missing request")
      expect(
        await t.usage.sweepExpiredReservations(new Date(Date.now() + 86400001), run.workspaceId),
      ).toBe(1);
    if (cut === "native storage") {
      vi.spyOn(port, "poll").mockImplementationOnce(async (_job, billing) => {
        await billing!.record({ ...pricedClip(), media: null, providerDurationSeconds: null });
        throw new Error("storage offline");
      });
    }
    if (cut === "artifact write")
      vi.spyOn(t.storage, "putObject").mockRejectedValueOnce(new Error("storage offline"));
    const stopped = cut === "emergency stop" || cut === "legacy hold before stop";
    if (cut === "legacy hold before stop")
      await t.db.videoRun.update({
        where: { id: run.id },
        data: { pauseReason: "RECONCILE_REQUIRED: provider billing exceeded reservation" },
      });
    if (stopped) {
      t.stop.stopped = true;
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("halted");
    }
    if (cut === "legacy hold before stop") {
      // A repeated boundary check must not discard the reason saved on entry to the stop.
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("halted");
      t.stop.stopped = false;
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Reconcile");
      expect((await t.store.get(t.context, run.id)).pauseReason).toBe("EMERGENCY_STOP");
      await t.engine.process(t.runs.job(t.context, run.id, pending!.id));
      expect(submit).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
    }
    await expect(t.engine.process(job)).rejects.toThrow(
      cut === "artifact write" || cut === "native storage" ? "storage offline" : "billing exceeded",
    );
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request.actualCost?.toNumber()).toBe(cut === "native storage" ? 0.7 : 0.84);
    expect(request.estimatedCost?.toNumber()).toBe(0.7);
    expect(request).toMatchObject({
      currency: "USD",
      createdAt: reservation.createdAt,
      errorCode: cut === "native storage" ? null : "VIDEO_RUN_BILLING_OVERAGE",
    });
    const compete = (): ReturnType<typeof t.usage.reserve> =>
      t.usage.reserve(run.workspaceId, {
        category: "VIDEO_MEDIA",
        currency: "USD",
        amountMinor: 22,
        idempotencyKey: "competing-run",
      });
    await expect(compete()).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(
      await t.usage.sweepExpiredReservations(new Date(Date.now() + 86400001), run.workspaceId),
    ).toBe(cut === "swept missing request" ? 0 : 1);
    await expect(compete()).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    t.stop.stopped = false;
    if (stopped) {
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Reconcile");
      expect((await t.store.get(t.context, run.id)).pauseReason).toBe("EMERGENCY_STOP");
    }
    await t.engine.process(job);
    await t.engine.process(job);
    expect(submit).toHaveBeenCalledOnce();
    expect(collectReceipt).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot!.id } })).toMatchObject({
      state: "SUCCEEDED",
      output: { storageArtifacts: [{ kind: "clips" }], receipt: { costMinor: 84 } },
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 84,
      reservedMinor: 21,
      overageMinor: 14,
    });
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "COMMITTED",
      committedMinor: 84n,
    });
    if (stopped) {
      expect((await t.store.get(t.context, run.id)).pauseReason).toBe("EMERGENCY_STOP");
      await t.engine.process(t.runs.job(t.context, run.id, pending!.id));
      expect(submit).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      await t.control.resume(t.context, run.id);
      expect(enqueue).toHaveBeenCalledOnce();
    }
  });

  it.each([6, 8])("replays legacy payment after a %i-second poll", async (seconds) => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const shot = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const port = Object.assign(t.generation.provider, {
      collectReceipt: vi.fn(async () => pricedClip(8)),
    });
    vi.spyOn(port, "estimate").mockReturnValue(56);
    vi.spyOn(port, "poll")
      .mockResolvedValueOnce("running")
      .mockImplementationOnce(async (_id, billing) => {
        await billing!.record({
          ...pricedClip(seconds),
          media: null,
          providerDurationSeconds: null,
        });
        return "succeeded";
      });
    const submit = vi.spyOn(port, "submit");
    const job = t.runs.job(t.context, run.id, shot.id);
    await expect(t.engine.process(job)).resolves.toBe(12000);
    const where = { workspaceId: run.workspaceId, correlationId: shot.id };
    const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
    await t.usage.commit(run.workspaceId, reservation.id, 56);
    await t.db.providerRequest.updateMany({
      where,
      data: {
        providerId: "v3-stub",
        status: "SUCCEEDED",
        errorCode: null,
        actualCost: 0.56,
        responseMetadata: { dispatched: true, costKnown: true },
      },
    });
    const committed = await t.db.usageReservation.findFirstOrThrow({ where });
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      providerJobId: expect.any(String),
      output: {
        receiptBudget: {
          admittedMinor: 105,
          bufferMinor: 49,
          estimateMinor: 56,
        },
      },
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 0,
      reservedMinor: 70,
    });
    await t.engine.process(job);
    await t.engine.process(job);
    expect(submit).toHaveBeenCalledOnce();
    expect(port.collectReceipt).toHaveBeenCalledOnce();
    expect(await t.db.usageReservation.findMany({ where })).toEqual([committed]);
    const requests = await t.db.providerRequest.findMany({ where });
    expect(requests).toMatchObject([{ status: "SUCCEEDED", errorCode: null }]);
    expect(requests[0]!.actualCost?.toNumber()).toBe(0.56);
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "SUCCEEDED",
      costMinor: 56,
      output: { receipt: { costMinor: 56 }, storageArtifacts: [{ kind: "clips" }] },
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 49,
      spentMinor: 56,
      overageMinor: 0,
    });
    expect(
      await t.db.runEvent.count({
        where: { runId: run.id, type: "step_completed", stepId: shot.id },
      }),
    ).toBe(1);
  });

  it("recovers only the failed run's shot with a durable job receipt before attachment", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    await generateClips(t);
    const source = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "CRITIC" } });
    const replacement = await t.control.reshoot(t.context, run.id, 0, source.id);
    const shot = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: replacement! } });
    const baseline = await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    const job = t.runs.job(t.context, run.id, shot.id);
    const submit = vi
      .spyOn(t.generation.provider, "submit")
      .mockResolvedValue({ providerJobId: "accepted" });
    const reconcile = vi.spyOn(t.generation.provider, "reconcile");
    vi.spyOn(t.runs, "attachJob").mockImplementationOnce(async () => {
      await t.db.videoRun.update({
        where: { id: run.id },
        data: { state: "FAILED", pauseReason: "PROVIDER_INVALID" },
      });
      throw new Error("worker stopped");
    });
    await expect(t.engine.process(job)).rejects.toThrow("worker stopped");
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "RUNNING",
      providerJobId: null,
    });
    expect(
      await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: shot.id } }),
    ).toMatchObject({ responseMetadata: { providerJobId: "accepted" } });
    const enqueue = vi.fn<RunsQueue["enqueue"]>();
    t.runs.queue = { enqueue } as unknown as RunsQueue;
    await t.engine.recover();
    const jobs = enqueue.mock.calls.filter(([payload]) => payload.runId === run.id);
    expect(jobs.map(([payload]) => payload.stepId)).toEqual([shot.id]);
    await t.engine.process(jobs[0]![0]);
    await t.engine.process(jobs[0]![0]);
    expect(submit).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    const saved = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(saved).toMatchObject({ state: "SUCCEEDED", providerJobId: "accepted" });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: baseline.reservedMinor + (105 - saved.costMinor!),
      spentMinor: baseline.spentMinor + saved.costMinor!,
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: BigInt(saved.costMinor!) });
    expect((await t.store.get(t.context, run.id)).state).toBe("FAILED");
  });
});
