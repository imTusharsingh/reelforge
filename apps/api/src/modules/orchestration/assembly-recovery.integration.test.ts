import { expect, it, vi } from "vitest";
import { LocalAssemblyFailure } from "../composition/local-assembly-failure.js";
import { generating, generateClips, runsFixture } from "../runs/runs.fixture.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { VideoRunEngine } from "./video-run.engine.js";
import type { RunsQueue } from "../runs/runs.queue.js";

const fixture = runsFixture();
it.skipIf(!process.env.DATABASE_URL).each([
  ["CAPTIONS_UNREADABLE", false, [null], "CAPTIONS_UNREADABLE"],
  ["LOCAL_RENDER_TRANSIENT", true, [5000, 15000, null], "LOCAL_RENDER_RETRIES_EXHAUSTED"],
] as const)(
  "persists %s and does not restart an exhausted assembly",
  async (code, transient, delays, terminal) => {
    const t = await fixture.tenant("L2");
    await generating(t);
    await generateClips(t);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const job = { ...t.runs.job(t.context, t.run.id), assembly: true };
    const handler = t.planning.handlers.ASSEMBLING!;
    const failure = new LocalAssemblyFailure(code, "Fixture render failed", transient);
    const run = await t.store.get(t.context, t.run.id);
    expect(run.state).toBe("ASSEMBLING");
    const execute = vi.spyOn(handler, "execute").mockRejectedValue(failure);
    const reconcile = vi.spyOn(handler, "reconcile").mockRejectedValue(failure);
    const boundary = new RunsBoundary(
      { check: async (): Promise<typeof t.stop> => t.stop },
      t.runs,
    );
    const restart = (): VideoRunEngine =>
      new VideoRunEngine(t.runs, boundary, t.generation, t.planning, t.artifacts);
    for (const delay of delays) await expect(restart().process(job)).resolves.toBe(delay);
    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(delays.length - 1);
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({ pauseReason: terminal });
    expect(
      await t.db.videoRunStep.findFirst({
        where: { runId: t.run.id, key: "ASSEMBLING" },
      }),
    ).toMatchObject({
      state: "FAILED",
      error: { code: terminal, localRenderFailures: delays.length },
    });
    const enqueue = vi.fn();
    t.runs.queue = { enqueue } as unknown as RunsQueue;
    await restart().recover();
    expect(enqueue.mock.calls.filter(([entry]) => entry.runId === t.run.id)).toHaveLength(0);
    await expect(restart().process(job)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(delays.length - 1);
    execute.mockRestore();
    reconcile.mockRestore();
  },
);
