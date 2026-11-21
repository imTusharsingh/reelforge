import { describe, expect, it, vi } from "vitest";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { generateClips, generating, runsFixture } from "./runs.fixture.js";
import type { RunsQueue } from "./runs.queue.js";

function pricedClip(): VideoReceipt {
  return {
    costMinor: 70,
    seconds: 10,
    providerDurationSeconds: 10,
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
      billedSeconds: 10,
      durationSeconds: 10,
    },
  };
}
describe.skipIf(!process.env.DATABASE_URL)("shot receipt recovery", () => {
  const fixture = runsFixture();
  it.each([
    "missing request",
    "swept missing request",
    "artifact write",
    "native storage",
    "emergency stop",
  ])("preserves the full priced liability across %s", async (cut) => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const [shot, pending] = await t.db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const job = t.runs.job(t.context, run.id, shot!.id);
    const collectReceipt = vi.fn(async () => pricedClip());
    const port = Object.assign(t.generation.provider, { collectReceipt });
    const submit = vi.spyOn(port, "submit");
    const poll = vi.spyOn(port, "poll").mockResolvedValueOnce("running");
    vi.spyOn(port, "estimate").mockReturnValue(56);
    await t.usage.upsertBudget(t.context, {
      currency: "USD",
      monthlyLimitMinor: 70,
      reason: "overage test",
    });
    await expect(t.engine.process(job)).resolves.toBe(12000);
    const where = { workspaceId: run.workspaceId, correlationId: shot!.id };
    const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
    expect(reservation.amountMinor).toBe(56n);
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
    if (cut === "emergency stop") {
      t.stop.stopped = true;
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("halted");
    }
    await expect(t.engine.process(job)).rejects.toThrow(
      cut === "artifact write" || cut === "native storage" ? "storage offline" : "billing exceeded",
    );
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request.actualCost?.toNumber()).toBe(0.7);
    expect(request.estimatedCost?.toNumber()).toBe(0.56);
    expect(request).toMatchObject({
      currency: "USD",
      createdAt: reservation.createdAt,
      errorCode: "VIDEO_RUN_BILLING_OVERAGE",
    });
    const compete = (): ReturnType<typeof t.usage.reserve> =>
      t.usage.reserve(run.workspaceId, {
        category: "VIDEO_MEDIA",
        currency: "USD",
        amountMinor: 14,
        idempotencyKey: "competing-run",
      });
    await expect(compete()).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(
      await t.usage.sweepExpiredReservations(new Date(Date.now() + 86400001), run.workspaceId),
    ).toBe(cut === "swept missing request" ? 0 : 1);
    await expect(compete()).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    t.stop.stopped = false;
    if (cut === "emergency stop") {
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
      output: { storageArtifacts: [{ kind: "clips" }], receipt: { costMinor: 70 } },
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 70,
      reservedMinor: 0,
      overageMinor: 14,
    });
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "COMMITTED",
      committedMinor: 70n,
    });
    if (cut === "emergency stop") {
      expect((await t.store.get(t.context, run.id)).pauseReason).toBe("EMERGENCY_STOP");
      await t.engine.process(t.runs.job(t.context, run.id, pending!.id));
      expect(submit).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      await t.control.resume(t.context, run.id);
      expect(enqueue).toHaveBeenCalledOnce();
    }
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
      reservedMinor: 0,
      spentMinor: baseline.spentMinor + saved.costMinor!,
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: BigInt(saved.costMinor!) });
    expect((await t.store.get(t.context, run.id)).state).toBe("FAILED");
  });
});
