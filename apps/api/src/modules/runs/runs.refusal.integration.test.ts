import { describe, expect, it, vi } from "vitest";
import { capabilityCatalog, ProviderHttp, Interactions, OmniVideo } from "@reelforge/ai-providers";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import type { MediaJobs } from "../scene-media/media-jobs.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { ShotSpecSchema } from "@reelforge/contracts";
import { generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("polled video refusals", () => {
  const fixture = runsFixture();
  it.each(["success", "refused", "budget"] as const)(
    "replays one same-provider rewrite through %s",
    async (outcome) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const db = t.store.scoped(t.context);
      const source = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      await db.videoRunStep.updateMany({
        where: { runId: run.id, key: { startsWith: "shot-" }, id: { not: source.id } },
        data: { state: "SKIPPED" },
      });
      const provider = t.generation.provider;
      const submit = vi.spyOn(provider, "submit");
      const fallback = vi.spyOn(t.generation.fallbackProvider, "submit");
      const poll = vi
        .spyOn(provider, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("refused");
      const job = t.runs.job(t.context, run.id, source.id);
      expect(await t.engine.process(job)).toBe(12000);
      await Promise.all([t.engine.process(job), t.engine.process(job)]);
      await t.engine.process(job);
      const steps = await db.videoRunStep.findMany({
        where: { runId: run.id, key: source.key },
        orderBy: { attempt: "asc" },
      });
      expect(steps).toHaveLength(2);
      const [first, rewrite] = steps;
      expect(first).toMatchObject({
        state: "SKIPPED",
        error: { code: "PROVIDER_REFUSED", rewriteCount: 0 },
      });
      expect(rewrite).toMatchObject({
        state: "PENDING",
        output: { refusalRewrite: { sourceStepId: source.id, providerId: provider.providerId } },
      });
      expect(ShotSpecSchema.parse(rewrite!.input).motionPrompt).not.toBe(
        ShotSpecSchema.parse(source.input).motionPrompt,
      );
      const reservations = (): ReturnType<typeof t.db.usageReservation.findMany> =>
        t.db.usageReservation.findMany({
          where: { workspaceId: t.context.workspaceId },
          orderBy: { createdAt: "asc" },
        });
      expect(await reservations()).toMatchObject([
        { status: "COMMITTED", committedMinor: BigInt(first!.costMinor!) },
      ]);
      await db.budgetEnvelope.updateMany({
        where: { runId: run.id },
        data: {
          route: "FALLBACK",
          ...(outcome === "budget"
            ? { baseEstimateMinor: first!.costMinor!, reshootReserveMinor: 0 }
            : {}),
        },
      });
      const replacement = t.runs.job(t.context, run.id, rewrite!.id);
      if (outcome === "budget") {
        await expect(t.engine.process(replacement)).rejects.toThrow("Envelope exhausted");
        expect((await t.store.get(t.context, run.id)).state).toBe("PAUSED_BUDGET");
        expect(await reservations()).toHaveLength(1);
        expect(submit).toHaveBeenCalledOnce();
      } else {
        poll
          .mockResolvedValueOnce("running")
          .mockResolvedValue(outcome === "refused" ? "refused" : "succeeded");
        expect(await t.engine.process(replacement)).toBe(12000);
        expect(await reservations()).toMatchObject([
          { status: "COMMITTED" },
          { status: "RESERVED", correlationId: rewrite!.id },
        ]);
        await t.engine.process(replacement);
        await t.engine.process(replacement);
        await t.engine.process(t.runs.job(t.context, run.id));
        expect((await t.store.get(t.context, run.id)).state).toBe(
          outcome === "refused" ? "NEEDS_HUMAN" : "ASSEMBLING",
        );
        expect(await db.videoRunStep.count({ where: { runId: run.id, key: source.key } })).toBe(2);
        expect(await reservations()).toMatchObject([
          { status: "COMMITTED" },
          { status: "COMMITTED" },
        ]);
        expect(submit.mock.calls.map((call) => call[1])).toEqual([
          source.idempotencyKey,
          rewrite!.idempotencyKey,
        ]);
      }
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it.each(["safety", "safety without ID", "403"] as const)(
    "settles immediate rewrite response %s across restart",
    async (outcome) => {
      const t = await fixture.tenant("L2", 42);
      const run = await generating(t);
      const db = t.store.scoped(t.context);
      const source = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      await db.videoRunStep.updateMany({
        where: { runId: run.id, key: { startsWith: "shot-" }, id: { not: source.id } },
        data: { state: "SKIPPED" },
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ status: "queued", id: "first" }))
        .mockResolvedValueOnce(Response.json({ status: "refused" }))
        .mockResolvedValueOnce(
          outcome === "403"
            ? Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 })
            : Response.json({
                status: "failed",
                error: { code: "safety" },
                ...(outcome === "safety" ? { id: "second" } : {}),
              }),
        );
      const cap = capabilityCatalog(
        run.workspaceId,
        {
          video: "omni",
          xaiVideo: "grok",
          text: "text",
          image: "image",
          music: "music",
          tts: "tts",
        },
        { gemini: true, xai: true },
      )[0]!;
      const restart = (): void => {
        const client = new Interactions(
          new ProviderHttp("AIza" + "abc".repeat(12), "gemini", fetcher),
          {
            save: async (): Promise<never> => {
              throw new Error("Unexpected download");
            },
          },
        );
        t.generation.provider = new RoutedMediaVideo(
          new OmniVideo(client, cap, { resolve: async (): Promise<[]> => [] }),
          {} as MediaJobs,
          t.context,
          run,
        );
      };
      restart();
      await t.engine.process(t.runs.job(t.context, run.id, source.id));
      const replacement = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: source.key, attempt: 2 },
      });
      const job = t.runs.job(t.context, run.id, replacement.id);
      restart();
      await t.engine.process(job);
      restart();
      await t.engine.process(job);
      const charged = outcome !== "403";
      const spent = charged ? 98 : 49;
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: charged ? "NEEDS_HUMAN" : "FAILED",
      });
      expect(
        await db.videoRunStep.findFirstOrThrow({ where: { id: replacement.id } }),
      ).toMatchObject({ state: "FAILED", providerJobId: outcome === "safety" ? "second" : null });
      expect(
        await t.db.providerRequest.findFirstOrThrow({
          where: { workspaceId: run.workspaceId, correlationId: replacement.id },
        }),
      ).toMatchObject({
        errorCode: charged ? "PROVIDER_JOB_FAILED" : "NOT_DISPATCHED",
        ...(charged ? {} : { errorMessage: "Provider refusal (HTTP 403, PERMISSION_DENIED)" }),
        responseMetadata: {
          dispatched: charged,
          ...(outcome === "safety" ? { providerJobId: "second" } : {}),
        },
      });
      expect(await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
        spentMinor: spent,
        reservedMinor: 0,
      });
      const reservations = await t.db.usageReservation.findMany({
        where: { workspaceId: run.workspaceId },
        orderBy: { createdAt: "asc" },
      });
      expect(reservations.map((r) => [r.status, r.committedMinor])).toEqual([
        ["COMMITTED", 49n],
        charged ? ["COMMITTED", 49n] : ["RELEASED", null],
      ]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps a replaced undispatched rewrite on its admitted vendor and stops on refusal", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const db = t.store.scoped(t.context);
    const source = await db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const provider = t.generation.provider;
    const submit = vi.spyOn(provider, "submit");
    const fallback = vi.spyOn(t.generation.fallbackProvider, "submit");
    vi.spyOn(provider, "poll").mockResolvedValue("refused");
    await t.engine.process(t.runs.job(t.context, run.id, source.id));
    const rewrite = await db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: source.key, attempt: 2 },
    });
    const cut = vi
      .spyOn(RunPaidCalls.prototype, "dispatch")
      .mockRejectedValueOnce(new Error("worker stopped"));
    try {
      await expect(t.generation.process(t.context, run, rewrite.id)).rejects.toThrow(
        "worker stopped",
      );
    } finally {
      cut.mockRestore();
    }
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { pauseReason: "RECONCILE_REQUIRED: sibling" },
    });
    await t.control.abandon(t.context, run.id, rewrite.id);
    await db.budgetEnvelope.updateMany({ where: { runId: run.id }, data: { route: "FALLBACK" } });
    await t.control.resume(t.context, run.id);
    const retry = await db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: source.key, attempt: 3 },
    });
    await t.engine.process(t.runs.job(t.context, run.id, retry.id));
    await t.engine.process(t.runs.job(t.context, run.id, retry.id));
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "NEEDS_HUMAN",
      pauseReason: "PROVIDER_REFUSED",
    });
    expect(await db.videoRunStep.count({ where: { runId: run.id, key: source.key } })).toBe(3);
    expect(
      await t.db.usageReservation.findMany({
        where: { workspaceId: run.workspaceId },
        orderBy: { createdAt: "asc" },
      }),
    ).toMatchObject([{ status: "COMMITTED" }, { status: "RELEASED" }, { status: "COMMITTED" }]);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("preserves the refusal decision while collecting an accepted sibling", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const db = t.store.scoped(t.context);
    const [first, accepted, pending] = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const process = (id: string): Promise<number | null> =>
      t.engine.process(t.runs.job(t.context, run.id, id));
    const submit = vi.spyOn(t.generation.provider, "submit");
    const poll = vi
      .spyOn(t.generation.provider, "poll")
      .mockResolvedValueOnce("running")
      .mockResolvedValue("refused");
    expect(await process(accepted!.id)).toBe(12000);
    await process(first!.id);
    const rewrite = await db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: first!.key, attempt: 2 },
    });
    await process(rewrite.id);
    for (let i = 0; i < 2; i++) {
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow(
        "Refused shot requires human resolution",
      );
      await process(pending!.id);
      poll.mockResolvedValue("succeeded");
      await process(accepted!.id);
    }
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "NEEDS_HUMAN",
      pauseReason: "PROVIDER_REFUSED",
    });
    expect(await db.videoRunStep.findFirstOrThrow({ where: { id: accepted!.id } })).toMatchObject({
      state: "SUCCEEDED",
    });
    expect(await db.videoRunStep.findFirstOrThrow({ where: { id: pending!.id } })).toMatchObject({
      state: "PENDING",
    });
    expect(submit).toHaveBeenCalledTimes(3);
    expect(await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
    });
  });
});
