import { describe, expect, it, vi } from "vitest";
import { generating, runsFixture } from "../runs/runs.fixture.js";
import { RunsQueue } from "../runs/runs.queue.js";
import type { VideoGenPort } from "../orchestration/video-run.handlers.js";
import { correctionHold, persistPendingCorrection } from "./run-pending-receipt.js";

describe.skipIf(!process.env.DATABASE_URL)("refusal after a bill is durably observed", () => {
  const fixture = runsFixture();
  it("carries the bill across refusal and recovers without the original caller", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const source = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const job = t.runs.job(t.context, run.id, source.id);
    const port: VideoGenPort = t.generation.provider;
    const sent = vi.spyOn(port, "submit");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<"refused">();
    vi.spyOn(port, "poll")
      .mockResolvedValueOnce("running")
      .mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
    await t.engine.process(job);
    const waiting = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } });
    const costMinor = (waiting.costMinor ?? 0) + 8;
    const refusal = t.engine.process(job);
    await Promise.race([
      entered.promise,
      refusal.then(() => {
        throw new Error("refusal poll did not start");
      }),
    ]);
    await persistPendingCorrection(t.store, t.context, waiting, {
      costBasis: "BILLED",
      costMinor,
      seconds: 8,
      modelId: "fixture",
      promptVersion: "fixture",
      media: null,
      providerDurationSeconds: null,
    });
    release.resolve("refused");
    await refusal;
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
      state: "SKIPPED",
      error: { code: "PROVIDER_REFUSED" },
      output: { pendingRefusalBill: { costMinor, providerJobId: waiting.providerJobId } },
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      pauseReason: correctionHold(source.id),
    });
    const enqueue = vi.fn();
    t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
    await t.engine.recover();
    const replay = enqueue.mock.calls.find(([queued]) => queued.stepId === source.id)?.[0];
    expect(replay).toBeDefined();
    await t.engine.process(replay);
    await t.engine.process(replay);
    const settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } });
    expect(settled).toMatchObject({
      state: "SKIPPED",
      costMinor,
      error: { code: "PROVIDER_REFUSED" },
    });
    expect(settled.output).not.toHaveProperty("pendingRefusalBill");
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: source.id } }),
    ).toMatchObject({
      committedMinor: BigInt(costMinor),
    });
    expect(sent).toHaveBeenCalledOnce();
  });
});
