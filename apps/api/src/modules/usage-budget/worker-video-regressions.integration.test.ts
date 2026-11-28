import { secondsCost, TerminalMediaJob, type VideoGenPort } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { StorageObjectNotFoundError } from "../asset/storage/storage.port.js";
import * as billing from "./run-billing.js";
import * as bookLocks from "./text-admission-lock.js";
import { workerVideo } from "./worker-video.fixture.js";

function billedPort(native: VideoGenPort): VideoGenPort {
  const cap = native.capabilities();
  return {
    ...native,
    capabilities: () => ({ ...cap, pricePerSecond: { ...cap.pricePerSecond, "720p": 10_000 } }),
    estimate: () => secondsCost(30, 10_000),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("worker terminal-video regressions", () => {
  const fixture = runsFixture();

  it("keeps a terminal bill when the budget lock times out before settlement", async () => {
    const t = await fixture.tenant("L2", 35);
    const { run, step, job, native } = await workerVideo(t, (port) => ({
      ...billedPort(port),
      estimate: (shot): ReturnType<VideoGenPort["estimate"]> =>
        secondsCost(shot.durationSeconds, 10_000),
    }));
    const send = vi.spyOn(native, "submit");
    const poll = vi
      .spyOn(native, "poll")
      .mockResolvedValueOnce("running")
      .mockImplementationOnce(async (_id, record) => {
        await record?.(23, "refused");
        return "refused";
      })
      .mockResolvedValue("refused");
    expect(await t.engine.process(job)).toBe(12000);
    const lock = vi
      .spyOn(bookLocks, "lockBooks")
      .mockRejectedValueOnce(new Error("budget lock timeout"));
    try {
      await expect(t.engine.process(job)).rejects.toThrow("budget lock timeout");
    } finally {
      lock.mockRestore();
    }
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      output: { terminalVideo: { status: "refused", billedMinor: 23 } },
    });
    expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
    await t.engine.process(job);
    expect(
      await t.db.usageReservation.findFirstOrThrow({
        where: { workspaceId: run.workspaceId, correlationId: step.id },
      }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 23n });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([5, null])(
    "keeps a successful in-flight clip when refusal is staged (usage: %s)",
    async (seconds) => {
      const t = await fixture.tenant("L2", 35);
      const { run, step, job, native } = await workerVideo(t, billedPort);
      const send = vi.spyOn(native, "submit");
      const fetching = Promise.withResolvers<void>();
      const releaseFetch = Promise.withResolvers<void>();
      const noted = Promise.withResolvers<void>();
      const releaseRefusal = Promise.withResolvers<void>();
      const fetch = native.fetch.bind(native);
      vi.spyOn(native, "fetch").mockImplementation(async (id) => {
        fetching.resolve();
        await releaseFetch.promise;
        return { ...(await fetch(id)), billedSeconds: seconds };
      });
      vi.spyOn(native, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("succeeded")
        .mockImplementationOnce(async (_id, record) => {
          await record?.(23, "refused");
          noted.resolve();
          await releaseRefusal.promise;
          return "refused";
        });
      await t.engine.process(job);
      const recorded = Promise.withResolvers<void>();
      const releaseCapture = Promise.withResolvers<void>();
      const capture = billing.captureShotReceipt;
      const captureGate = vi
        .spyOn(billing, "captureShotReceipt")
        .mockImplementationOnce(async (...args) => {
          recorded.resolve();
          await releaseCapture.promise;
          return capture(...args);
        });
      const success = t.engine.process(job);
      let refusal: ReturnType<typeof t.engine.process> | undefined;
      try {
        await Promise.race([fetching.promise, success]);
        refusal = t.engine.process(job);
        await Promise.race([noted.promise, refusal]);
        releaseFetch.resolve();
        await Promise.race([recorded.promise, success]);
        releaseRefusal.resolve();
        await refusal;
        expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
        releaseCapture.resolve();
        await success;
        const winner = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
        expect(winner).toMatchObject({
          state: "SUCCEEDED",
          costMinor: 23,
          output: { receipt: { costMinor: 23, seconds: 23, providerDurationSeconds: 5 } },
        });
        expect(t.artifacts.descriptors(winner.output)).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "clips" })]),
        );
        expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
        expect(send).toHaveBeenCalledOnce();
      } finally {
        releaseFetch.resolve();
        releaseRefusal.resolve();
        releaseCapture.resolve();
        await Promise.allSettled([success, refusal]);
        captureGate.mockRestore();
      }
    },
  );

  it("rejects failed recovery of a missing staged clip without dropping its bill", async () => {
    const t = await fixture.tenant("L2", 35);
    const { run, step, job, native } = await workerVideo(t, billedPort);
    const send = vi.spyOn(native, "submit");
    vi.spyOn(native, "poll").mockResolvedValueOnce("running").mockResolvedValue("succeeded");
    const fetch = native.fetch.bind(native);
    vi.spyOn(native, "fetch")
      .mockImplementationOnce(fetch)
      .mockImplementationOnce(async (_id, record) => {
        await record?.(23, "failed");
        throw new TerminalMediaJob("failed");
      });
    await t.engine.process(job);
    const get = vi
      .spyOn(t.storage, "getObject")
      .mockRejectedValueOnce(new StorageObjectNotFoundError("staged clip missing on first read"));
    try {
      await expect(t.engine.process(job)).rejects.toThrow(TerminalMediaJob);
    } finally {
      get.mockRestore();
    }
    expect(
      await t.db.providerRequest
        .findFirstOrThrow({
          where: { workspaceId: run.workspaceId, correlationId: step.id },
        })
        .then((row) => row.actualCost?.mul(100).toNumber()),
    ).toBe(23);
    expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });
});
