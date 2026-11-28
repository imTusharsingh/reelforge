import { secondsCost, type VideoGenPort } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { ShotSpecSchema } from "@reelforge/contracts";
import type { ShotBilling } from "../orchestration/video-run.handlers.js";
import * as billing from "./run-billing.js";
import { workerVideo } from "./worker-video.fixture.js";

function inexpensive(port: VideoGenPort): VideoGenPort {
  const cap = port.capabilities();
  return {
    ...port,
    capabilities: () => ({ ...cap, pricePerSecond: { ...cap.pricePerSecond, "720p": 10_000 } }),
    estimate: () => secondsCost(5, 10_000),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("recovering atomic video evidence", () => {
  const fixture = runsFixture();

  it("recovers the clip and higher terminal bill when both workers stop before posting", async () => {
    const t = await fixture.tenant("L2", 35);
    const { run, step, job, native } = await workerVideo(t, inexpensive);
    const submit = vi.spyOn(native, "submit");
    const polled = Promise.withResolvers<void>();
    const refuse = Promise.withResolvers<void>();
    vi.spyOn(native, "poll")
      .mockResolvedValueOnce("running")
      .mockImplementationOnce(async (_id, record) => {
        polled.resolve();
        await refuse.promise;
        await record?.(23, "refused");
        return "refused";
      })
      .mockResolvedValue("succeeded");
    await t.engine.process(job);
    const process = async (): Promise<number | null> =>
      t.generation.process(t.context, await t.store.get(t.context, run.id), step.id);
    const refusal = process();
    const post = vi
      .spyOn(billing, "captureShotReceipt")
      .mockRejectedValueOnce(new Error("stopped before accounting"))
      .mockRejectedValueOnce(new Error("stopped before accounting"));
    try {
      await Promise.race([polled.promise, refusal]);
      await expect(process()).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "stopped before accounting" }),
      });
      refuse.resolve();
      await expect(refusal).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "stopped before accounting" }),
      });
    } finally {
      refuse.resolve();
      await Promise.allSettled([refusal]);
      post.mockRestore();
    }
    const where = { workspaceId: run.workspaceId, correlationId: step.id };
    const saved = (): ReturnType<typeof t.db.videoRunStep.findUniqueOrThrow> =>
      t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(await saved()).toMatchObject({
      state: "WAITING_EXTERNAL",
      error: { costBasis: "BILLED", costMinor: 23, seconds: 23, media: { durationSeconds: 5 } },
    });
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
    await t.engine.process(job);
    await t.engine.process(job);
    expect(await saved()).toMatchObject({
      state: "SUCCEEDED",
      costMinor: 23,
      output: { receipt: { costMinor: 23, seconds: 23 }, storageArtifacts: [{ kind: "clips" }] },
    });
    expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
      { status: "COMMITTED", committedMinor: 23n },
    ]);
    expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps the delivered overage hold during an equal-price replay and reconciles it once", async () => {
    const t = await fixture.tenant("L2", 35);
    const { run, step, job, native } = await workerVideo(t, inexpensive);
    const submit = vi.spyOn(native, "submit");
    vi.spyOn(native, "poll").mockResolvedValueOnce("running").mockResolvedValue("succeeded");
    const fetch = native.fetch.bind(native);
    vi.spyOn(native, "fetch").mockImplementation(async (id) => ({
      ...(await fetch(id)),
      billedSeconds: 23,
    }));
    await t.engine.process(job);
    await expect(t.engine.process(job)).rejects.toThrow("RECONCILE_REQUIRED");
    const saved = (): ReturnType<typeof t.db.videoRunStep.findUniqueOrThrow> =>
      t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
    const held = await saved();
    expect(held).toMatchObject({
      state: "WAITING_EXTERNAL",
      error: { code: "VIDEO_RUN_BILLING_OVERAGE" },
      output: { storageArtifacts: [{ kind: "clips" }], receipt: { costMinor: 23 } },
    });
    // Use the very same provider callback a concurrent worker gets after collecting its clip.
    const ports = await t.generation.resolvePorts!(
      t.context,
      run,
      ShotSpecSchema.parse(held.input),
      true,
    );
    const { videoBilling } = await import("../orchestration/video-run.terminal.js");
    const { RunPaidCalls } = await import("./run-paid.js");
    const { persistPendingCorrection } = await import("./run-pending-receipt.js");
    const collector: ShotBilling = videoBilling(t.runs, t.context, held, async (receipt) => {
      await persistPendingCorrection(t.store, t.context, held, receipt);
      return billing.captureShotReceipt(
        t.store,
        new RunPaidCalls(t.usage, t.store),
        t.context,
        held,
        receipt,
      );
    });
    const duplicate = await ports!.primary.collectReceipt!(
      held.providerJobId!,
      collector.shot,
      collector,
    );
    await collector.record(duplicate);
    expect(await saved()).toMatchObject({ error: held.error, output: held.output });
    await t.engine.process(job);
    await t.engine.process(job);
    expect(await saved()).toMatchObject({ state: "SUCCEEDED", costMinor: 23, error: null });
    expect(
      await t.db.usageReservation.findMany({ where: { correlationId: step.id } }),
    ).toMatchObject([{ status: "COMMITTED", committedMinor: 23n }]);
    expect(submit).toHaveBeenCalledOnce();
  });
});
