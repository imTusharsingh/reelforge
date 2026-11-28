import { Interactions, OmniVideo, ProviderHttp } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { RunPaidCalls } from "./run-paid.js";
import { workerVideo } from "./worker-video.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("verified terminal video settlement and restart", () => {
  const fixture = runsFixture();
  it.each([
    { source: "submit", crash: false, hasId: true },
    { source: "submit", crash: true, hasId: false },
    { source: "poll", crash: true, hasId: true },
    { source: "fetch", crash: true, hasId: true },
    { source: "failed fetch", crash: true, hasId: true },
  ])("settles $source (crash: $crash, ID: $hasId)", async ({ source, crash, hasId }) => {
    const t = await fixture.tenant("L2", 35);
    const refused = source !== "failed fetch";
    const terminal = (): Response =>
      Response.json({
        ...(hasId && { id: "original" }),
        status: refused ? "refused" : "failed",
        usage: { billed_seconds: 23 },
      });
    const save = vi.fn().mockRejectedValue(new Error("Terminal job has no media"));
    let posts = 0;
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        if (posts === 1)
          return source === "submit"
            ? terminal()
            : Response.json({ status: "queued", id: "original" });
        const posting = await t.db.usageReservation.findFirstOrThrow({
          where: { workspaceId: t.run.workspaceId, correlationId: step.id },
        });
        // A second provider POST is not allowed to race the verified liability.
        expect(posting).toMatchObject({ status: "COMMITTED", committedMinor: 23n });
        expect(
          (await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor,
        ).toBeGreaterThanOrEqual(23);
        return Response.json({ status: "queued", id: "rewrite" });
      }
      reads++;
      if (posts === 2) return Response.json({ status: "in_progress", id: "rewrite" });
      if (reads === 1) return Response.json({ status: "in_progress", id: "original" });
      if (reads === 2 && source.endsWith("fetch"))
        return Response.json({ status: "completed", id: "original" });
      return terminal();
    });
    const { run, step, job } = await workerVideo(t, (native) => {
      const capability = native.capabilities();
      return new OmniVideo(
        new Interactions(new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher), { save }),
        { ...capability, pricePerSecond: { ...capability.pricePerSecond, "720p": 10000 } },
        { resolve: async (): Promise<[]> => [] },
      );
    });
    if (source !== "submit") expect(await t.engine.process(job)).toBe(12000);
    const processOriginal = async (): Promise<number | null> =>
      t.generation.process(t.context, await t.store.get(t.context, run.id), step.id);
    if (crash) {
      const settle = vi
        .spyOn(RunPaidCalls.prototype, "settleFailedRequest")
        .mockRejectedValueOnce(new Error("fixture interrupted at settlement"));
      try {
        await expect(processOriginal()).rejects.toThrow("fixture interrupted");
      } finally {
        settle.mockRestore();
      }
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
        output: { terminalVideo: { providerJobId: hasId ? "original" : null, billedMinor: 23 } },
      });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
      if (!hasId) {
        await t.db.usageReservation.updateMany({
          where: { workspaceId: run.workspaceId, correlationId: step.id },
          data: { status: "EXPIRED", expiresAt: new Date(0) },
        });
        expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
      }
      expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: step.key } })).toBe(1);
    }
    const beforeRestart = fetcher.mock.calls.length;
    await t.engine.process(job);
    await t.engine.process(job);
    if (crash) expect(fetcher).toHaveBeenCalledTimes(beforeRestart);
    expect(
      await t.db.providerRequest.findFirstOrThrow({
        where: { workspaceId: run.workspaceId, correlationId: step.id },
      }),
    ).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_JOB_FAILED",
      estimatedCost: expect.anything(),
      responseMetadata: { costKnown: true, dispatched: true },
    });
    const posting = await t.db.usageReservation.findFirstOrThrow({
      where: { workspaceId: run.workspaceId, correlationId: step.id },
    });
    expect(posting).toMatchObject({ status: "COMMITTED", committedMinor: 23n });
    const after = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(after).toMatchObject({
      state: refused ? "SKIPPED" : "FAILED",
      providerJobId: hasId ? "original" : null,
      costMinor: 23,
    });
    if (refused) {
      const rewrite = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: step.key, attempt: 2 },
      });
      await t.engine.process(t.runs.job(t.context, run.id, rewrite.id));
    }
    expect(posts).toBe(refused ? 2 : 1);
    expect(save).not.toHaveBeenCalled();
  });
});
