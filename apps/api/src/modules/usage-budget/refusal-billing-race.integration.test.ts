import { describe, expect, it, vi } from "vitest";
import { generating, runsFixture } from "../runs/runs.fixture.js";
import { RunsQueue } from "../runs/runs.queue.js";
import type { VideoGenPort } from "../orchestration/video-run.handlers.js";
import { captureShotReceipt } from "./run-billing.js";
import { RunPaidCalls } from "./run-paid.js";
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
  it.each(["refused", "failed"] as const)(
    "keeps an already posted exact price when a later poll reports %s",
    async (terminal) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const step = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      const job = t.runs.job(t.context, run.id, step.id);
      const port: VideoGenPort = t.generation.provider;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<typeof terminal>();
      vi.spyOn(port, "poll")
        .mockResolvedValueOnce("running")
        .mockImplementationOnce(async () => {
          entered.resolve();
          return release.promise;
        });
      await t.engine.process(job);
      const waiting = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
      const costMinor = (waiting.costMinor ?? 0) + 4;
      const failure = t.engine.process(job);
      await Promise.race([
        entered.promise,
        failure.then(() => {
          throw new Error("terminal poll did not start");
        }),
      ]);
      await captureShotReceipt(t.store, new RunPaidCalls(t.usage, t.store), t.context, waiting, {
        costBasis: "BILLED",
        costMinor,
        seconds: 9,
        modelId: "fixture",
        promptVersion: "fixture",
        media: null,
        providerDurationSeconds: null,
      });
      release.resolve(terminal);
      await failure;
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
        state: terminal === "refused" ? "SKIPPED" : "FAILED",
        costMinor,
      });
      const where = { workspaceId: run.workspaceId, correlationId: step.id };
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        status: "COMMITTED",
        committedMinor: BigInt(costMinor),
      });
      const request = await t.db.providerRequest.findFirstOrThrow({ where });
      expect(request.status).toBe("FAILED");
      expect(request.actualCost?.mul(100).toNumber()).toBe(costMinor);
    },
  );

  it("settles a terminal bill under an emergency stop without sending another provider request", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const port: VideoGenPort = t.generation.provider;
    const submit = vi.spyOn(port, "submit");
    vi.spyOn(port, "poll").mockResolvedValueOnce("running").mockResolvedValue("refused");
    const source = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const job = t.runs.job(t.context, run.id, source.id);
    await t.engine.process(job);
    await t.engine.process(job);
    const refused = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } });
    const costMinor = (refused.costMinor ?? 0) + 8;
    await persistPendingCorrection(t.store, t.context, refused, {
      costBasis: "BILLED",
      costMinor,
      seconds: 8,
      modelId: "fixture",
      promptVersion: "fixture",
      media: null,
      providerDurationSeconds: null,
    });
    t.stop.stopped = true;
    await t.engine.process(job);
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: source.id } }),
    ).toMatchObject({
      status: "COMMITTED",
      committedMinor: BigInt(costMinor),
    });
    const other = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-1" },
    });
    await expect(t.engine.process(t.runs.job(t.context, run.id, other.id))).rejects.toThrow(
      "halted",
    );
    expect(submit).toHaveBeenCalledOnce();
  });
});
