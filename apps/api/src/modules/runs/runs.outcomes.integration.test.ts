import { createHash, randomUUID } from "node:crypto";
import { ModuleRef } from "@nestjs/core";
import { ShotSpecSchema } from "@reelforge/contracts";
import {
  capabilityCatalog,
  GeminiText,
  Interactions,
  OmniVideo,
  ProviderFailure,
  ProviderHttp,
} from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { shotReceiptBufferMinor } from "../usage-budget/run-envelope.js";
import { RunsBoundary } from "./runs.boundary.js";
import type { Prisma } from "@reelforge/database";
import type { Step } from "./runs.types.js";
import type { RunsQueue } from "./runs.queue.js";
import { generating, runsFixture, type Tenant } from "./runs.fixture.js";

function attempt(t: Tenant, key: string): Promise<Step> {
  const db = t.store.scoped(t.context);
  return db.videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key } });
}

async function accounting(
  t: Tenant,
  stepId: string,
): Promise<{
  request: Prisma.ProviderRequestGetPayload<object>;
  reservation: Prisma.UsageReservationGetPayload<object>;
  envelope: Prisma.BudgetEnvelopeGetPayload<object> | null;
}> {
  const where = { workspaceId: t.context.workspaceId, correlationId: stepId };
  const [request, reservation, envelope] = await Promise.all([
    t.db.providerRequest.findFirstOrThrow({ where }),
    t.db.usageReservation.findFirstOrThrow({ where }),
    t.store.scoped(t.context).budgetEnvelope.findFirst({ where: { runId: t.run.id } }),
  ]);
  return { request, reservation, envelope };
}

function adapters(t: Tenant, fetcher: typeof fetch): { text: GeminiText; video: OmniVideo } {
  const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
  const interactions = new Interactions(http, {
    save: async (): Promise<never> => {
      throw new Error("Unexpected provider artifact");
    },
  });
  const catalog = capabilityCatalog(
    t.context.workspaceId,
    {
      video: "omni-fixture",
      xaiVideo: "xai-fixture",
      text: "text-fixture",
      image: "image-fixture",
      tts: "tts-fixture",
      music: "music-fixture",
    },
    { gemini: true, xai: true },
  );
  return {
    text: new GeminiText(interactions, "text-fixture"),
    video: new OmniVideo(interactions, catalog[0]!, { resolve: async () => [] }),
  };
}

function rejection(status = 400, code = "INVALID_ARGUMENT"): Response {
  return Response.json({ error: { status: code, message: "untrusted remote text" } }, { status });
}

describe.skipIf(!process.env.DATABASE_URL)("durable paid run outcomes", () => {
  const fixture = runsFixture();

  it.each(["unknown", "rejected"] as const)(
    "protects admitted claims when cancel precedes a %s outcome",
    async (outcome) => {
      const t = await fixture.tenant();
      await generating(t);
      const step = await attempt(t, "shot-0");
      const admitted = Promise.withResolvers<void>();
      const provider = Promise.withResolvers<never>();
      vi.spyOn(t.generation.provider, "submit").mockImplementation(() => {
        admitted.resolve();
        return provider.promise;
      });
      const processing = t.engine.process(t.runs.job(t.context, t.run.id, step.id));
      const settled = processing.catch((error: unknown) => error);
      try {
        await Promise.race([admitted.promise, processing]);
        const before = await accounting(t, step.id);
        await t.control.cancel(t.context, t.run.id);
        expect(await accounting(t, step.id)).toEqual(before);
        expect(before.request.errorCode).toBe("VIDEO_RUN_DISPATCHING");
      } finally {
        provider.reject(
          outcome === "unknown"
            ? new Error("transport lost")
            : new ProviderFailure("INVALID", false),
        );
        await settled;
      }
      const run = await t.store.get(t.context, t.run.id);
      const after = await accounting(t, step.id);
      expect(run.state).toBe("CANCELED");
      if (outcome === "unknown") {
        expect(await settled).toMatchObject({
          message: expect.stringMatching(/^RECONCILE_REQUIRED/),
        });
        expect(run.pauseReason).toContain(step.id);
        expect(after.request.errorCode).toBe("VIDEO_RUN_OUTCOME_UNKNOWN");
        expect(after.reservation.status).toBe("RESERVED");
        expect(after.envelope).toMatchObject({
          reservedMinor: Number(after.reservation.amountMinor),
          spentMinor: 0,
        });
        expect((await attempt(t, "shot-0")).state).toBe("RUNNING");
      } else {
        expect(await settled).toBeNull();
        expect(run.pauseReason).toBeNull();
        expect(after.request.errorCode).toBe("NOT_DISPATCHED");
        expect(after.reservation.status).toBe("RELEASED");
        expect(after.envelope).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
        expect((await attempt(t, "shot-0")).state).toBe("FAILED");
      }
    },
  );

  it.each(["unknown", "rejected"] as const)(
    "preserves a settled %s submission outcome when cancel follows",
    async (outcome) => {
      const t = await fixture.tenant();
      await generating(t);
      const step = await attempt(t, "shot-0");
      vi.spyOn(t.generation.provider, "submit").mockRejectedValue(
        outcome === "unknown"
          ? new ProviderFailure("OUTAGE", true)
          : new ProviderFailure("INVALID", false),
      );
      const processing = t.engine.process(t.runs.job(t.context, t.run.id, step.id));
      if (outcome === "unknown") await expect(processing).rejects.toThrow("RECONCILE_REQUIRED");
      else await expect(processing).resolves.toBeNull();
      const run = await t.store.get(t.context, t.run.id);
      const before = await accounting(t, step.id);
      const recordedStep = await attempt(t, "shot-0");
      expect(before.request.errorCode).toBe(
        outcome === "unknown" ? "VIDEO_RUN_OUTCOME_UNKNOWN" : "NOT_DISPATCHED",
      );
      if (outcome === "unknown") {
        await expect(t.control.abandon(t.context, t.run.id, step.id)).rejects.toThrow("Reconcile");
        expect(await accounting(t, step.id)).toEqual(before);
        expect(
          await t.store.scoped(t.context).videoRunStep.count({
            where: { runId: t.run.id, key: step.key },
          }),
        ).toBe(1);
      }
      await t.control.cancel(t.context, t.run.id);
      if (outcome === "unknown")
        await expect(t.control.abandon(t.context, t.run.id, step.id)).rejects.toThrow("Reconcile");
      expect(await t.store.get(t.context, t.run.id)).toMatchObject({
        state: "CANCELED",
        pauseReason: run.pauseReason,
      });
      expect(await accounting(t, step.id)).toEqual(before);
      expect(await attempt(t, "shot-0")).toEqual(recordedStep);
    },
  );

  it("settles racing finalizers once and drains a waiting sibling through recovery and fanout", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const scoped = t.store.scoped(t.context);
    const failed = await attempt(t, "shot-0");
    const sibling = await attempt(t, "shot-1");
    await scoped.videoRunStep.updateMany({
      where: {
        runId: run.id,
        key: { startsWith: "shot-" },
        id: { notIn: [failed.id, sibling.id] },
      },
      data: { state: "SKIPPED" },
    });
    const poll = vi.spyOn(t.generation.provider, "poll").mockResolvedValueOnce("running");
    const siblingJob = t.runs.job(t.context, run.id, sibling.id);
    await expect(t.engine.process(siblingJob)).resolves.toBe(12000);
    expect(await attempt(t, "shot-1")).toMatchObject({
      state: "WAITING_EXTERNAL",
      providerJobId: expect.any(String),
    });

    const paid = new RunPaidCalls(t.usage, t.store);
    const rejected = new ProviderFailure("INVALID", false);
    // The real generation finalizer races another delivery of the same outcome.
    const finalize = RunPaidCalls.prototype.finalizeRejected;
    const race = vi
      .spyOn(RunPaidCalls.prototype, "finalizeRejected")
      .mockImplementation(async function (this: RunPaidCalls, context, step, failure) {
        const all = await Promise.allSettled([
          finalize.call(this, context, step, failure),
          finalize.call(paid, context, step, failure),
        ]);
        expect(all.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
        const first = all[0]!;
        if (first.status === "rejected") throw first.reason;
        return first.value;
      });
    const submit = vi.spyOn(t.generation.provider, "submit").mockRejectedValueOnce(rejected);
    try {
      await expect(t.engine.process(t.runs.job(t.context, run.id, failed.id))).resolves.toBeNull();
    } finally {
      race.mockRestore();
    }
    const first = await accounting(t, failed.id);
    const second = await accounting(t, sibling.id);
    expect(first.reservation.status).toBe("RELEASED");
    expect(second.reservation.status).toBe("RESERVED");
    expect(first.envelope).toMatchObject({
      reservedMinor: Number(second.reservation.amountMinor),
      spentMinor: 0,
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });

    const queue = { enqueue: vi.fn<RunsQueue["enqueue"]>(), fanout: vi.fn<RunsQueue["fanout"]>() };
    t.runs.queue = queue as unknown as RunsQueue;
    const current = await t.store.get(t.context, run.id);
    await t.runs.move(t.context, current, "PAUSED_BUDGET", "BUDGET_CAP");
    await t.engine.recover();
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runId: run.id, stepId: sibling.id }),
      expect.any(Number),
    );
    await t.control.resume(t.context, run.id);
    await t.engine.process(t.runs.job(t.context, run.id));
    expect(queue.fanout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: run.id }),
      [sibling.id],
      expect.any(Number),
    );
    await expect(t.engine.process(siblingJob)).resolves.toBeNull();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledOnce();
    const finishedShot = await attempt(t, "shot-1");
    expect(finishedShot).toMatchObject({ state: "SUCCEEDED" });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_INVALID",
    });
    const finished = await accounting(t, sibling.id);
    const receiptBuffer = shotReceiptBufferMinor(finishedShot.costMinor!);
    expect(finished.reservation).toMatchObject({
      status: "COMMITTED",
      committedMinor: BigInt(finishedShot.costMinor!),
    });
    expect(finished.envelope).toMatchObject({
      reservedMinor: receiptBuffer,
      spentMinor: finishedShot.costMinor,
    });
  });

  it("skips a pending shot whose required continuity source was rejected", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const scoped = t.store.scoped(t.context);
    const source = await attempt(t, "shot-0");
    const dependent = await attempt(t, "shot-1");
    await scoped.videoRunStep.updateMany({
      where: {
        runId: run.id,
        key: { startsWith: "shot-" },
        id: { notIn: [source.id, dependent.id] },
      },
      data: { state: "SKIPPED" },
    });
    const shot = ShotSpecSchema.parse(dependent.input);
    await scoped.videoRunStep.updateMany({
      where: { id: dependent.id },
      data: { input: { ...shot, firstFrameFrom: { previousShotOrdinal: 0 } } },
    });
    const submit = vi
      .spyOn(t.generation.provider, "submit")
      .mockRejectedValueOnce(new ProviderFailure("INVALID", false));
    const job = t.runs.job(t.context, run.id, dependent.id);
    await expect(t.engine.process(job)).resolves.toBe(12000);
    expect(submit).not.toHaveBeenCalled();
    await expect(t.engine.process(t.runs.job(t.context, run.id, source.id))).resolves.toBeNull();
    expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "GENERATING" });
    await expect(t.engine.process(job)).resolves.toBeNull();
    expect(await attempt(t, "shot-1")).toMatchObject({
      state: "SKIPPED",
      error: { code: "CONTINUITY_SOURCE_UNAVAILABLE" },
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "FAILED" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
  ] as const)(
    "settles HTTP %s through the production video bridge without losing diagnostics",
    async (status, code) => {
      const t = await fixture.tenant("L2", 42);
      await generating(t);
      const step = await attempt(t, "shot-0");
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejection(status, code));
      const { video } = adapters(t, fetcher);
      const access = { artifacts: t.artifacts } as MediaAccess;
      t.generation.provider = new RoutedMediaVideo(
        video,
        new MediaJobs(access, new MediaAccounts(access), t.storage),
        t.context,
        t.run,
      );
      await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).resolves.toBeNull();
      const saved = await accounting(t, step.id);
      expect(saved.request).toMatchObject({
        errorCode: "NOT_DISPATCHED",
        errorMessage: `Provider refusal (HTTP ${status}, ${code})`,
        responseMetadata: { dispatched: false, costKnown: true },
      });
      expect(saved.reservation.status).toBe("RELEASED");
      expect(saved.envelope).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
      expect(await attempt(t, "shot-0")).toMatchObject({ state: "FAILED" });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("closes the planning text attempt and fails closed on the next pass", async () => {
    const narrator = {
      providerId: "gemini" as const,
      voiceId: "narrator",
      pace: 1,
      language: "English",
    };
    const t = await fixture.tenant("L2", 42, narrator, false);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const run = await t.store.get(t.context, t.run.id);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejection());
    const { text } = adapters(t, fetcher);
    const paid = new RunPaidCalls(t.usage, t.store);
    const prompt = {
      capture: vi.fn<PlanningPromptService["capture"]>().mockResolvedValue({
        prompt: "fixture prompt",
        receipt: {
          role: "scriptwriter",
          version: 2,
          templateVersionId: randomUUID(),
          promptSnapshotId: randomUUID(),
          configSnapshotId: randomUUID(),
          fingerprintSha256: createHash("sha256").update("fixture").digest("hex"),
        },
      }),
      format: vi.fn<PlanningPromptService["format"]>().mockResolvedValue({}),
    };
    const boundary = new RunsBoundary(
      { check: async (): Promise<Tenant["stop"]> => t.stop },
      t.runs,
    );
    const modules = {
      get: (token: unknown): unknown => (token === PlanningPromptService ? prompt : {}),
    } as ModuleRef;
    const access = { modules, runs: t.runs, paid, artifacts: t.artifacts, boundary };
    const accounts = new MediaAccounts(access);
    const jobs = new MediaJobs(access, accounts, t.storage);
    const ports = { get: vi.fn().mockResolvedValue({ text }) } as unknown as MediaPorts;
    const planning = new MediaPlanning(access, accounts, jobs, ports);
    const plan = async (): Promise<never> => {
      await planning.plan(t.context, run, t.brief);
      throw new Error("Unexpected successful plan");
    };
    t.planning.handlers = { ...t.planning.handlers, SCRIPTING: { execute: plan, reconcile: plan } };

    await expect(t.engine.process(t.runs.job(t.context, run.id))).rejects.toMatchObject({
      kind: "INVALID",
      dispatched: false,
      http: { status: 400, code: "INVALID_ARGUMENT" },
    });
    const step = await attempt(t, "media:text:scriptwriter");
    expect(step).toMatchObject({
      state: "FAILED",
      costMinor: 0,
      error: { code: "PROVIDER_INVALID", message: "Provider invalid (HTTP 400, INVALID_ARGUMENT)" },
    });
    const saved = await accounting(t, step.id);
    expect(saved.request).toMatchObject({
      errorCode: "NOT_DISPATCHED",
      responseMetadata: { dispatched: false, costKnown: true },
    });
    expect(saved.request.actualCost?.toString()).toBe("0");
    expect(saved.reservation).toMatchObject({ status: "RELEASED", committedMinor: null });
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_INVALID",
    });
    expect(await attempt(t, "SCRIPTING")).toMatchObject({ state: "FAILED" });
    await expect(planning.plan(t.context, run, t.brief)).rejects.toThrow(
      "Planning provider request was rejected",
    );
    await expect(t.engine.process(t.runs.job(t.context, run.id))).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
