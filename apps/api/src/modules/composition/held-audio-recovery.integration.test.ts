import { afterEach, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { RunsQueue } from "../runs/runs.queue.js";
import { submissionHold } from "../runs/run-outcomes.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

const fixture = runsFixture();
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL)(
  "keeps the owner hold through two sweeps that attach and settle ledger-only audio",
  async () => {
    const { t, run, native, bindings } = await setupAssembly(fixture);
    const music = vi.spyOn(native.music, "submit");
    const narration = vi.spyOn(native.tts, "submit");
    vi.spyOn(t.runs, "attachJob").mockRejectedValueOnce(
      new Error("worker stopped before attachment"),
    );
    await expect(
      bindings.jobs.tick(
        t.context,
        run,
        "music",
        native.music,
        { prompt: "instrumental" },
        8,
        "music",
        "v1",
        30,
      ),
    ).rejects.toThrow("worker stopped");
    const step = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "media:music" },
    });
    expect(step.providerJobId).toBeNull();
    const { providerJobId } = await music.mock.results[0]!.value;
    expect(await bindings.access.paid.jobReceipt(t.context, step)).toBe(providerJobId);
    const pauseReason = submissionHold(step.id);
    await t.db.videoRun.update({ where: { id: run.id }, data: { pauseReason } });
    music.mockClear();
    vi.spyOn(native.music, "poll").mockResolvedValueOnce("running").mockResolvedValue("succeeded");
    bindMedia(t, native);
    const enqueue = vi.fn<RunsQueue["enqueue"]>().mockResolvedValue(undefined);
    t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
    for (const state of ["WAITING_EXTERNAL", "SUCCEEDED"]) {
      enqueue.mockClear();
      await t.engine.recover();
      expect(enqueue.mock.calls.map(([job]) => job)).toMatchObject([
        { runId: run.id, assembly: true, collectOnly: true },
      ]);
      await t.engine.process(enqueue.mock.calls[0]![0]);
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "ASSEMBLING",
        pauseReason,
      });
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
        state,
        providerJobId,
      });
    }
    expect(music).not.toHaveBeenCalled();
    expect(narration).not.toHaveBeenCalled();
    expect(
      await t.db.usageReservation.findMany({ where: { workspaceId: run.workspaceId } }),
    ).toMatchObject([{ correlationId: step.id, status: "COMMITTED", committedMinor: 8n }]);
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 8,
      reservedMinor: 0,
    });
    await expect(t.control.resume({ ...t.context, role: "EDITOR" }, run.id)).rejects.toThrow(
      "owner",
    );
    await t.control.resume(t.context, run.id);
    expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
  },
);
