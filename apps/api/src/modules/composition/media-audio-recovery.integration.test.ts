import { DelayedError, Queue, Worker } from "bullmq";
import { parseRedisConnection } from "../runs/redis-connection.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interactions, GeminiTts, ProviderHttp } from "@reelforge/ai-providers";
import { runsFixture } from "../runs/runs.fixture.js";
import { RunsQueue } from "../runs/runs.queue.js";
import type { Run, RunJob } from "../runs/runs.types.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";
describe.skipIf(!process.env.DATABASE_URL)("assembly audio recovery", () => {
  const fixture = runsFixture();
  beforeEach(() => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["narration", "music"] as const)(
    "drains the accepted sibling when %s fails",
    async (failed) => {
      const { t, run, plan, native } = await setupAssembly(fixture);
      const bad = failed === "music" ? native.music : native.tts;
      const sibling = failed === "music" ? native.tts : native.music;
      const badSubmit = vi.spyOn(bad, "submit");
      const siblingSubmit = vi.spyOn(sibling, "submit");
      vi.spyOn(bad, "poll").mockResolvedValueOnce("running").mockResolvedValue("failed");
      vi.spyOn(sibling, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("running");
      const collect = vi.spyOn(sibling, "fetch");
      const job = { ...t.runs.job(t.context, t.run.id), assembly: true as const };
      expect(await t.engine.process(job)).toBe(12000);
      expect(await t.engine.process(job)).toBe(12000);
      const rows = t.store.scoped(t.context).videoRunStep;
      expect(await rows.findFirst({ where: { runId: run.id, key: "ASSEMBLING" } })).toMatchObject({
        state: "FAILED",
      });
      expect((await t.store.get(t.context, run.id)).state).toBe("ASSEMBLING");
      vi.spyOn(bindMedia(t, native).planning, "saved").mockResolvedValue(plan);
      const revision = (await t.store.get(t.context, run.id)).revision;
      const add = vi.fn();
      t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), {
        queue: { getJob: async () => null, add },
      });
      for (let i = 0; i < 3; i++) {
        await t.engine.recover();
        expect(await t.engine.process(job)).toBe(12000);
      }
      const scheduled = add.mock.calls.filter((call) => call[1].runId === run.id);
      expect(scheduled.map((call) => call[2].jobId)).toEqual(Array(3).fill(`${run.id}-assembly`));
      expect((await t.store.get(t.context, run.id)).revision).toBe(revision);
      expect(
        await t.db.runEvent.count({ where: { runId: run.id, type: "assembly_input_failed" } }),
      ).toBe(1);
      vi.mocked(sibling.poll).mockResolvedValue("succeeded");
      await expect(t.engine.process(job)).resolves.toBeNull();
      await expect(t.engine.process(job)).resolves.toBeNull();
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "FAILED",
        pauseReason: "PROVIDER_FAILED",
      });
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
      ).toMatchObject([{ status: "COMMITTED" }, { status: "COMMITTED" }]);
      expect(
        await t.store.scoped(t.context).budgetEnvelope.findFirst({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 0, spentMinor: 9 });
      expect(badSubmit).toHaveBeenCalledOnce();
      expect(siblingSubmit).toHaveBeenCalledOnce();
      expect(collect).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "forwards a late generation flow parent to the one delayed assembly job",
    async () => {
      vi.stubEnv("GEMINI_IMAGE_MODEL", "fixture-image");
      const { t, run, native } = await setupAssembly(fixture, true);
      const db = t.store.scoped(t.context);
      await db.videoRun.updateMany({ where: { id: run.id }, data: { state: "GENERATING" } });
      const last = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      const poll = vi.spyOn(native.music, "poll").mockResolvedValue("running");
      const queueName = `recovery-${run.id}`;
      const queue = new RunsQueue(process.env.REDIS_URL!, queueName);
      const connection = parseRedisConnection(process.env.REDIS_URL!);
      const inspect = new Queue<RunJob>(queueName, { connection });
      const parent = t.runs.job(t.context, run.id);
      t.runs.queue = queue;
      // Both parents are queued before the final child settles. Gate their processing
      // to reproduce the sweep winning the transition while the old flow parent waits.
      await queue.fanout(parent, [last.id], run.revision);
      await queue.enqueue(parent, run.revision);
      const enqueue = vi.spyOn(queue, "enqueue");
      const childSettled = Promise.withResolvers<void>();
      const transitioned = Promise.withResolvers<void>();
      const completed: string[] = [];
      const failures: string[] = [];
      let flowParentState: Run["state"] | undefined;
      const worker = new Worker<RunJob>(
        queueName,
        async (job, token) => {
          const sweep = job.id === `${run.id}-${run.revision}`;
          if (sweep) await childSettled.promise;
          if (job.name === "assemble") {
            await transitioned.promise;
            flowParentState = (await t.store.get(t.context, run.id)).state;
          }
          const delay = await t.engine.process(job.data);
          if (job.data.stepId) childSettled.resolve();
          if (sweep) transitioned.resolve();
          if (delay !== null) {
            await job.moveToDelayed(Date.now() + delay, token);
            throw new DelayedError();
          }
        },
        { connection, concurrency: 3 },
      );
      worker.on("failed", (_job, error) => failures.push(error.message));
      worker.on("completed", (job) => completed.push(job.id!));
      try {
        await vi.waitFor(
          async () => {
            expect(failures).toEqual([]);
            expect(completed).toContain(`${run.id}-assemble-${run.revision}`);
            expect(completed).toContain(`${run.id}-${run.revision}`);
            const delayed = await inspect.getDelayed();
            expect(delayed.map((job) => job.id)).toEqual([`${run.id}-assembly`]);
          },
          { timeout: 10000 },
        );
        expect(flowParentState).toBe("ASSEMBLING");
        expect(enqueue.mock.calls.filter(([data]) => data.assembly)).toHaveLength(2);
        expect(poll).toHaveBeenCalledOnce();
      } finally {
        childSettled.resolve();
        transitioned.resolve();
        await worker.close();
        await inspect.obliterate();
        await Promise.all([queue.close(), inspect.close()]);
      }
    },
    15000,
  );

  it.each(["music", "narration"] as const)(
    "releases the prepared sibling when %s fails before sibling dispatch",
    async (failed) => {
      const { t, run, native, bindings, job } = await setupAssembly(fixture);
      const bad = failed === "music" ? native.music : native.tts;
      const other = failed === "music" ? native.tts : native.music;
      const submit = vi.spyOn(other, "submit");
      const ready = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      vi.spyOn(bad, "poll")
        .mockResolvedValueOnce("running")
        .mockImplementation(async () => {
          await ready.promise;
          return "failed";
        });
      const cost = failed === "music" ? 8 : 1;
      if (failed === "music")
        await bindings.jobs.tick(
          t.context,
          run,
          failed,
          native.music,
          { prompt: "music" },
          cost,
          "music",
          "v1",
          30,
        );
      else
        await bindings.jobs.tick(
          t.context,
          run,
          failed,
          native.tts,
          { text: "voice", voice: "fixture" },
          cost,
          "voice",
          "v1",
          30,
        );
      const prepare = bindings.accounts.prepare.bind(bindings.accounts);
      vi.spyOn(bindings.accounts, "prepare").mockImplementation(async (...args) => {
        await prepare(...args);
        ready.resolve();
        await settled.promise;
      });
      const finish = bindings.access.paid.finalizeJobFailure.bind(bindings.access.paid);
      vi.spyOn(bindings.access.paid, "finalizeJobFailure").mockImplementation(async (...args) => {
        try {
          return await finish(...args);
        } finally {
          settled.resolve();
        }
      });
      await t.engine.process(job);
      await t.engine.process(job);
      expect(submit).not.toHaveBeenCalled();
      expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "FAILED" });
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 0, spentMinor: cost });
      expect(
        await t.db.usageReservation.findMany({
          where: { workspaceId: run.workspaceId },
          orderBy: { createdAt: "asc" },
        }),
      ).toMatchObject([{ status: "COMMITTED" }, { status: "RELEASED" }]);
    },
  );

  it("settles a submit-time Gemini refusal and collects its accepted sibling on restart", async () => {
    const { t, run, native, bindings, job, plan } = await setupAssembly(fixture);
    vi.spyOn(native.music, "poll").mockResolvedValue("running");
    await bindings.jobs.tick(
      t.context,
      run,
      "music",
      native.music,
      { prompt: "music" },
      8,
      "music",
      "v1",
      30,
    );
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "failed", id: "refused-tts", error: { code: "safety" } }),
      );
    native.tts = new GeminiTts(
      new Interactions(new ProviderHttp("AIza" + "abc".repeat(12), "gemini", http), {
        save: async (): Promise<never> => {
          throw new Error("Unexpected download");
        },
      }),
      "voice",
    );
    expect(await t.engine.process(job)).toBe(12000);
    vi.spyOn(bindMedia(t, native).planning, "saved").mockResolvedValue(plan);
    vi.mocked(native.music.poll).mockResolvedValue("succeeded");
    await t.engine.process(job);
    await t.engine.process(job);
    expect(http).toHaveBeenCalledOnce();
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_REFUSED",
    });
    const track = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "media:narration" },
    });
    expect(track).toMatchObject({ state: "FAILED", providerJobId: "refused-tts" });
    expect(
      await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: track.id } }),
    ).toMatchObject({ responseMetadata: { dispatched: true, providerJobId: "refused-tts" } });
    expect(
      await t.db.usageReservation.count({
        where: { workspaceId: run.workspaceId, status: "COMMITTED" },
      }),
    ).toBe(2);
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 9,
    });
  });

  it.each(["attached", "ledger only", "ledger only during emergency stop"])(
    "recovers %s audio with new dispatch closed",
    async (boundary) => {
      const { t, run, native, bindings, job } = await setupAssembly(fixture);
      const music = vi.spyOn(native.music, "submit"),
        voice = vi.spyOn(native.tts, "submit");
      vi.spyOn(native.music, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("succeeded");
      const collect = vi.spyOn(native.music, "fetch");
      if (boundary !== "attached") {
        const record = bindings.access.paid.recordJob.bind(bindings.access.paid);
        vi.spyOn(bindings.access.paid, "recordJob").mockImplementation(async (...args) => {
          await record(...args);
          if (args[1].key === "media:music") throw new Error("worker stopped after receipt");
        });
        await expect(t.engine.process(job)).rejects.toThrow("worker stopped after receipt");
      } else expect(await t.engine.process(job)).toBe(12000);
      const step = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "media:music" },
      });
      const submitted = await music.mock.results[0]!.value;
      if (boundary !== "attached") {
        expect(step).toMatchObject({ state: "RUNNING", providerJobId: null });
        expect(
          await t.db.providerRequest.findFirst({ where: { correlationId: step.id } }),
        ).toMatchObject({
          responseMetadata: { providerJobId: submitted.providerJobId },
        });
      }
      const stopped = boundary === "ledger only during emergency stop";
      if (stopped) {
        t.stop.stopped = true;
        await expect(bindings.access.boundary.check(t.context, run)).rejects.toThrow("Run halted");
      } else await t.control.cancel(t.context, run.id);
      const restarted = bindMedia(t, native);
      const render = vi.spyOn(restarted.renderer, "render");
      vi.spyOn(bindings.renderer, "render").mockImplementation(async () => {
        throw new Error("Unexpected render");
      });
      const enqueue = vi.fn<RunsQueue["enqueue"]>().mockResolvedValue(undefined);
      t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
      for (let sweep = 0; sweep < 2; sweep++) {
        enqueue.mockClear();
        await t.engine.recover();
        const queued = enqueue.mock.calls.filter(([data]) => data.runId === run.id);
        if (sweep === 0) expect(queued).toHaveLength(1);
        for (const [data] of queued) {
          expect(data.assembly).toBe(true);
          await t.engine.process(data);
        }
      }
      expect(await t.db.videoRunStep.findUnique({ where: { id: step.id } })).toMatchObject({
        state: "SUCCEEDED",
        providerJobId: submitted.providerJobId,
      });
      expect(collect).toHaveBeenCalledWith(submitted.providerJobId, 30);
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: stopped ? "ASSEMBLING" : "CANCELED",
        pauseReason: stopped ? "EMERGENCY_STOP" : null,
      });
      expect(music).toHaveBeenCalledOnce();
      expect(voice).toHaveBeenCalledOnce();
      expect(collect).toHaveBeenCalledOnce();
      expect(render).not.toHaveBeenCalled();
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({
        reservedMinor: 0,
        spentMinor: 9,
      });
      expect(
        await t.db.usageReservation.count({
          where: { workspaceId: run.workspaceId, status: "COMMITTED" },
        }),
      ).toBe(2);
    },
  );
});
