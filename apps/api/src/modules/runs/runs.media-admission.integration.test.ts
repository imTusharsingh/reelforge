import { ProviderFailure, type ImageGenPort } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { RunsBoundary } from "./runs.boundary.js";
import type { RunsQueue } from "./runs.queue.js";
import { generateClips, generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("media submission holds", () => {
  const fixture = runsFixture();

  it("preserves the generating stage on explicit resume after emergency clearance", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    t.stop.stopped = true;
    const queue = { enqueue: vi.fn(), fanout: vi.fn() };
    t.runs.queue = queue as unknown as RunsQueue;
    await expect(t.control.resume(t.context, run.id)).rejects.toThrow("halted");
    t.stop.stopped = false;
    await t.control.resume(t.context, run.id);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
    expect(queue.enqueue).toHaveBeenCalledOnce();
    await t.engine.process(t.runs.job(t.context, run.id));
    expect(queue.fanout).toHaveBeenCalledOnce();
  });
  it.each(["recover", "cancel"] as const)(
    "closes a legacy released media claim once through %s",
    async (action) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const access = {
        runs: t.runs,
        paid: new RunPaidCalls(t.usage, t.store),
        boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
      } as MediaAccess;
      const accounts = new MediaAccounts(access);
      const claim = async (
        key: string,
        amount: number,
      ): Promise<Awaited<ReturnType<typeof accounts.begin>>> => {
        const step = await accounts.begin(t.context, run, key, {}, amount, "fixture");
        await accounts.prepare(t.context, run, step, "fixture");
        await accounts.dispatch(t.context, step, async () => undefined);
        return step;
      };
      const sibling = await claim("media:music", 9);
      await t.runs.attachJob(t.context, sibling, "sibling");
      const legacy = await claim("media:keyframe:0:v1", 10);
      await access.paid.finish(t.context, legacy, false, 0);
      const submit = vi.fn();
      const jobs = new MediaJobs(access, accounts, t.storage);
      const recover = (): ReturnType<typeof jobs.tick> =>
        jobs.tick(
          t.context,
          run,
          "keyframe:0:v1",
          { submit, poll: vi.fn(), fetch: vi.fn() },
          {},
          10,
          "fixture",
          "v1",
        );
      if (action === "cancel") await t.control.cancel(t.context, run.id);
      await expect(recover()).rejects.toThrow("MEDIA_NOT_DISPATCHED");
      await expect(recover()).rejects.toThrow("MEDIA_NOT_DISPATCHED");
      expect(submit).not.toHaveBeenCalled();
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject(
        { state: "CANCELLED" },
      );
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 9, spentMinor: 0 });
      expect(
        await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: sibling.id } }),
      ).toMatchObject({ status: "RESERVED" });
    },
  );

  it("retains an 84-cent receipt on a 56-cent shot while its sibling attaches and settles", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const [a, b, c] = await t.db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const provider = t.generation.provider;
    vi.spyOn(provider, "estimate").mockReturnValue(56);
    const started = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<{ providerJobId: string }>();
    const submit = vi.spyOn(provider, "submit").mockImplementationOnce(() => {
      started.resolve();
      return receipt.promise;
    });
    Object.assign(provider, {
      collectReceipt: async (job: string) => ({
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
        providerDurationSeconds: 10,
        costBasis: "BILLED",
        costMinor: job === "sibling" ? 56 : 84,
        seconds: 10,
        modelId: "fixture",
        promptVersion: "fixture",
      }),
    });
    await t.usage.upsertBudget(t.context, {
      currency: "USD",
      monthlyLimitMinor: 154,
      reason: "priced overage",
    });
    const shotJob = (stepId: string): ReturnType<typeof t.engine.process> =>
      t.engine.process(t.runs.job(t.context, run.id, stepId));
    const sibling = shotJob(b!.id);
    try {
      await Promise.race([started.promise, sibling]);
      await expect(shotJob(a!.id)).rejects.toThrow("billing exceeded");
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Reconcile");
    } finally {
      receipt.resolve({ providerJobId: "sibling" });
      await sibling;
    }
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(a!.id);
    expect(await shotJob(c!.id)).toBeNull();
    expect(submit).toHaveBeenCalledTimes(2);
    const status = async (): Promise<number | undefined> =>
      (await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor;
    expect(await status()).toBe(154);
    await expect(
      t.usage.reserve(run.workspaceId, {
        category: "VIDEO_MEDIA",
        currency: "USD",
        amountMinor: 1,
        idempotencyKey: "competing-run",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    const fetch = vi.spyOn(provider, "fetch");
    await Promise.all([shotJob(a!.id), shotJob(a!.id)]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await status()).toBe(154);
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 140,
      reservedMinor: 14,
      overageMinor: 14,
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: a!.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 84n });
    expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
  });

  it("recovers an admitted keyframe independently of its pending parent and resumes a stale hold", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const { context } = t;
    const access = {
      runs: t.runs,
      artifacts: t.artifacts,
      paid: new RunPaidCalls(t.usage, t.store),
      boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
    } as MediaAccess;
    const jobs = new MediaJobs(access, new MediaAccounts(access), t.storage);
    const key = "keyframe:0:v1";
    const where = { runId: run.id, key: `media:${key}` };
    const port: ImageGenPort = {
      submit: vi.fn(async () => {
        const current = await t.store.get(context, run.id);
        await t.runs.move(context, current, "PAUSED_BUDGET", "BUDGET_CAP");
        await expect(t.control.resume(context, run.id)).rejects.toThrow("Reconcile");
        const frame = await t.db.videoRunStep.findFirstOrThrow({ where });
        expect(frame).toMatchObject({ state: "RUNNING", providerJobId: null });
        expect((await t.store.get(context, run.id)).pauseReason).toContain(frame.id);
        return { providerJobId: "frame-job" };
      }),
      poll: vi
        .fn<ImageGenPort["poll"]>()
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("succeeded"),
      fetch: vi.fn(async () => {
        const artifact = await t.artifacts.put(
          context,
          "keyframes",
          Buffer.from("frame"),
          "image/png",
        );
        return {
          ...artifact,
          mimeType: "image/png",
          durationSeconds: 0,
          width: 1,
          height: 1,
          fps: 0,
          billedSeconds: null,
        };
      }),
    };
    t.generation.recoverKeyframe = (ctx, step): Promise<number | null> =>
      jobs.recoverKeyframe(ctx, step, port);
    await expect(
      jobs.tick(
        context,
        run,
        key,
        port,
        { prompt: "fixture" },
        10,
        "fixture-model",
        "art-director:v2",
      ),
    ).resolves.toBeNull();
    const frame = await t.db.videoRunStep.findFirstOrThrow({ where });
    expect(frame).toMatchObject({ state: "WAITING_EXTERNAL", providerJobId: "frame-job" });
    expect(await t.store.get(context, run.id)).toMatchObject({
      state: "PAUSED_BUDGET",
      pauseReason: null,
    });
    const parent = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    expect(parent.state).toBe("PENDING");
    await expect(t.engine.process(t.runs.job(context, run.id, parent.id))).resolves.toBe(12000);
    expect(port.poll).toHaveBeenCalledTimes(2);

    const enqueue = vi.fn<RunsQueue["enqueue"]>();
    t.runs.queue = { enqueue } as unknown as RunsQueue;
    await t.engine.recover();
    const recovery = enqueue.mock.calls.find(
      ([job]) => job.runId === run.id && job.stepId === frame.id,
    );
    expect(recovery).toBeDefined();
    await expect(t.engine.process(recovery![0])).resolves.toBe(12000);
    // A job attached by an older worker may still carry the pre-receipt reason.
    await t.db.videoRun.updateMany({
      where: { id: run.id },
      data: {
        pauseReason: `RECONCILE_REQUIRED: provider submission outcome unknown (${frame.id})`,
      },
    });
    await t.control.resume(context, run.id);
    expect(await t.store.get(context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
    await expect(t.engine.process(recovery![0])).resolves.toBeNull();
    expect(port.submit).toHaveBeenCalledOnce();
    expect(port.poll).toHaveBeenCalledTimes(4);
    expect(await t.db.videoRunStep.findFirstOrThrow({ where })).toMatchObject({
      state: "SUCCEEDED",
      providerJobId: "frame-job",
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 10,
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: frame.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 10n });
  });
  it("clears the in-flight primary hold before enqueueing the confirmed non-dispatch fallback", async () => {
    const t = await fixture.tenant("L2", 30);
    await generating(t);
    const steps = await t.store.scoped(t.context).videoRunStep.findMany({
      where: { runId: t.run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    await t.engine.process(t.runs.job(t.context, t.run.id, steps[0]!.id));
    const primary = steps[1]!;
    vi.spyOn(t.generation.provider, "submit").mockImplementation(async () => {
      await expect(t.control.abandon(t.context, t.run.id, primary.id)).rejects.toThrow("Reconcile");
      expect((await t.store.get(t.context, t.run.id)).pauseReason).toContain(primary.id);
      throw new ProviderFailure("OUTAGE", false);
    });
    const enqueue = vi.fn<RunsQueue["enqueue"]>();
    t.runs.queue = { enqueue } as unknown as RunsQueue;
    await t.engine.process(t.runs.job(t.context, t.run.id, primary.id));
    const current = await t.store.get(t.context, t.run.id);
    expect(current).toMatchObject({ state: "GENERATING", pauseReason: null });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: current.id }),
      current.revision,
    );
    expect(
      await t.db.videoRunStep.findMany({
        where: { runId: current.id, key: primary.key },
        orderBy: { attempt: "asc" },
      }),
    ).toMatchObject([
      { state: "SKIPPED", costMinor: 0 },
      { state: "PENDING", attempt: 2 },
    ]);
    const budget = await t.store
      .scoped(t.context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    expect(budget.route).toBe("FALLBACK");
    expect(budget.baseEstimateMinor + budget.reshootReserveMinor).toBeLessThanOrEqual(800);
    await generateClips(t);
    const finished = await t.store
      .scoped(t.context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    expect(
      await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: current.id, key: primary.key, attempt: 2 },
      }),
    ).toMatchObject({ state: "SUCCEEDED", providerId: "xai" });
    expect(finished.spentMinor).toBeLessThanOrEqual(800);
    expect(finished.reservedMinor).toBeGreaterThan(0);
    expect(finished.spentMinor + finished.reservedMinor).toBeLessThanOrEqual(800);
  });
});
