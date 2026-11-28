import { Interactions, OmniVideo, ProviderHttp } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { workerVideo } from "./worker-video.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Gemini terminal video receipts", () => {
  const fixture = runsFixture();
  it("settles the 23-cent Gemini bill on a terminal refusal before scheduling a rewrite", async () => {
    const t = await fixture.tenant("L2", 35);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "omni-refusal-job", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "omni-refusal-job", status: "in_progress" }))
      .mockResolvedValueOnce(
        Response.json({
          id: "omni-refusal-job",
          status: "refused",
          usage: { billed_seconds: 23 },
        }),
      )
      .mockRejectedValue(new Error("unexpected offline request"));
    const save = vi.fn().mockRejectedValue(new Error("refused job must not save media"));
    const { run, step, job } = await workerVideo(t, (native) => {
      const capability = native.capabilities();
      return new OmniVideo(
        new Interactions(new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher), {
          save,
        }),
        { ...capability, pricePerSecond: { ...capability.pricePerSecond, "720p": 10000 } },
        { resolve: async (): Promise<[]> => [] },
      );
    });
    await t.engine.process(job);
    await t.engine.process(job);
    const where = { workspaceId: run.workspaceId, correlationId: step.id };
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request.estimatedCost?.toString()).toBe("0.09"); // 7-cent estimate plus the admission buffer.
    expect(request.actualCost?.toString()).toBe("0.23");
    expect(request).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_JOB_FAILED",
      responseMetadata: { providerJobId: "omni-refusal-job", dispatched: true, costKnown: true },
    });
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "COMMITTED",
      committedMinor: 23n,
    });
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
      state: "SKIPPED",
      costMinor: 23,
      error: { code: "PROVIDER_REFUSED" },
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: 23,
    });
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
    expect(
      fetcher.mock.calls.map(([url, options]) => [new URL(String(url)).pathname, options?.method]),
    ).toEqual([
      ["/v1beta/interactions", "POST"],
      ["/v1beta/interactions/omni-refusal-job", "GET"],
      ["/v1beta/interactions/omni-refusal-job", "GET"],
    ]);
    expect(save).not.toHaveBeenCalled();
  });
});
