import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderFailure, ProviderHttp } from "@reelforge/ai-providers";
import { report } from "../autonomy/autonomy.fixture.js";
import type { Step } from "./runs.types.js";
import type { Prisma } from "@reelforge/database";
import { ShotSpecSchema, VIDEO_RUN_TRANSITIONS } from "@reelforge/contracts";
import { runsFixture, generating, generateClips, type Tenant } from "./runs.fixture.js";
import { shotReceiptBufferMinor } from "../usage-budget/run-envelope.js";

function shotZero(t: Tenant): Promise<Step> {
  return t.store
    .scoped(t.context)
    .videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key: "shot-0" } });
}

describe.skipIf(!process.env.DATABASE_URL)("V3 durable VideoRun", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("runs deterministic stages without a media call in create, then awaits final approval", async () => {
    const t = await fixture.tenant("L3");
    const submit = vi.spyOn(t.generation.provider, "submit");
    expect(t.run.effectiveAutonomy).toBe("L2");
    expect(submit).not.toHaveBeenCalled();
    expect((await t.runs.create(t.context, t.brief.id, t.run.idempotencyKey)).id).toBe(t.run.id);
    await expect(t.runs.create(t.context, randomUUID(), t.run.idempotencyKey)).rejects.toThrow();
    await generating(t);
    await generateClips(t);
    vi.spyOn(t.planning.handlers.CRITIC!, "execute").mockResolvedValueOnce(report);
    for (let i = 0; i < 3; i++) await t.engine.process(t.runs.job(t.context, t.run.id));
    const run = await t.store.get(t.context, t.run.id);
    expect(run.state).toBe("AWAITING_APPROVAL");
    const detail = await t.runs.detail(t.context, run.id);
    expect(detail).toMatchObject({ envelope: { reservedMinor: 84, spentMinor: 318 } });
    t.stop.stopped = true;
    await expect(t.control.approve(t.context, run.id)).rejects.toThrow("halted");
    expect((await t.store.get(t.context, run.id)).pauseReason).toBe("EMERGENCY_STOP");
    t.stop.stopped = false;
    await expect(t.control.approve(t.context, run.id)).rejects.toThrow("hard gates");
    await t.control.resume(t.context, run.id);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "AWAITING_APPROVAL",
      pauseReason: null,
    });
    await t.control.approve(t.context, run.id);
    expect((await t.store.get(t.context, run.id)).state).toBe("SCHEDULED");
    await expect(t.control.approve(t.context, run.id)).rejects.toThrow();
    const events = await t.store.events(t.context, run.id, 0);
    expect(events.filter((event) => event.type === "approved")).toHaveLength(1);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    const states = events.filter((e) => e.type === "transition").map((e) => e.payload);
    expect(states).toHaveLength(7);
    expect(states.at(-1)).toMatchObject({ from: "AWAITING_APPROVAL", to: "AWAITING_APPROVAL" });
    expect(submit).toHaveBeenCalledTimes(6);
  });
  it("waits for script approval at L1 and rejects viewer actions", async () => {
    const t = await fixture.tenant("L1");
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("PLANNING");
    await t.control.approve(t.context, t.run.id);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("SCRIPTING");
    await expect(t.control.approve({ ...t.context, role: "VIEWER" }, t.run.id)).rejects.toThrow();
    await t.control.approve(t.context, t.run.id);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("SHOT_PLANNING");
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.control.approve(t.context, t.run.id);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("GENERATING");
  });
  it("rejects illegal/stale transitions and scopes every run aggregate", async () => {
    const t = await fixture.tenant(),
      other = await fixture.tenant();
    await expect(
      t.store.transition(t.context, t.run.id, t.run.revision, "PUBLISHED"),
    ).rejects.toThrow();
    await t.runs.move(t.context, t.run, "SCRIPTING");
    await expect(
      t.store.transition(t.context, t.run.id, t.run.revision, "SCRIPTING"),
    ).rejects.toThrow();
    await expect(t.store.get(other.context, t.run.id)).rejects.toThrow();
    await expect(t.runs.detail(other.context, t.run.id)).rejects.toThrow();
    await expect(t.store.events(other.context, t.run.id, 0)).rejects.toThrow();
    await expect(
      t.runs.create({ ...t.context, role: "VIEWER" }, t.brief.id, randomUUID()),
    ).rejects.toThrow();
    const scoped = t.store.scoped(other.context);
    expect(await scoped.videoRunStep.findMany({ where: { runId: t.run.id } })).toEqual([]);
    expect(await scoped.budgetEnvelope.findMany({ where: { runId: t.run.id } })).toEqual([]);
    expect(VIDEO_RUN_TRANSITIONS.PLANNING).toContain("CANCELED");
  });
  it("re-estimates a midrun predispatch outage at fallback rates", async () => {
    const t = await fixture.tenant("L2", 30);
    await generating(t);
    const steps = await t.store.scoped(t.context).videoRunStep.findMany({
      where: { runId: t.run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    await t.engine.process(t.runs.job(t.context, t.run.id, steps[0]!.id));
    vi.spyOn(t.generation.provider, "submit").mockRejectedValue(
      new ProviderFailure("OUTAGE", false),
    );
    await t.engine.process(t.runs.job(t.context, t.run.id, steps[1]!.id));
    const budget = await t.store
      .scoped(t.context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    expect(budget.route).toBe("FALLBACK");
    expect(budget.baseEstimateMinor + budget.reshootReserveMinor).toBeLessThanOrEqual(800);
    await generateClips(t);
    const finished = await t.store
      .scoped(t.context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    expect(finished.spentMinor).toBeLessThanOrEqual(800);
    expect(finished.reservedMinor).toBeGreaterThan(0);
    expect(finished.spentMinor + finished.reservedMinor).toBeLessThanOrEqual(800);
  });
  it("pauses before an over-envelope reshoot and enforces emergency stop", async () => {
    const t = await fixture.tenant();
    await generating(t);
    await t.store.scoped(t.context).budgetEnvelope.updateMany({
      where: { runId: t.run.id },
      data: { baseEstimateMinor: 1, reshootReserveMinor: 0 },
    });
    const step = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key: "shot-0" } });
    await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).rejects.toThrow();
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      state: "PAUSED_BUDGET",
      pauseReason: "BUDGET_CAP",
    });
    await t.control.resume(t.context, t.run.id);
    t.stop.stopped = true;
    const submit = vi.spyOn(t.generation.provider, "submit");
    await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect((await t.store.get(t.context, t.run.id)).pauseReason).toBe("EMERGENCY_STOP");
  });
  it.each([400, 408, 409, 429, 503, "network", "timeout", "malformed", "unconfirmed"] as const)(
    "finalizes or reconciles submission failure %s",
    async (status) => {
      const t = await fixture.tenant();
      await generating(t);
      const db = t.store.scoped(t.context);
      const step = await db.videoRunStep.findFirstOrThrow({
        where: { runId: t.run.id, key: "shot-0" },
      });
      const fetcher = vi.fn<typeof fetch>();
      if (status === "network") fetcher.mockRejectedValue(new Error("simulated transport failure"));
      else if (status === "timeout")
        fetcher.mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
                once: true,
              });
            }),
        );
      else if (status === "malformed")
        fetcher.mockResolvedValue(new Response("{", { status: 200 }));
      else if (status === "unconfirmed")
        fetcher.mockResolvedValue(new Response("{}", { status: 401 }));
      else
        fetcher.mockResolvedValue(
          new Response(
            JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "key=private" } }),
            { status },
          ),
        );
      const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher, 50);
      const submit = vi.spyOn(t.generation.provider, "submit").mockImplementation(async () => {
        await http.json("interactions", { prompt: "fixture" });
        throw new Error("Unexpected successful response");
      });
      const fallback = vi.spyOn(t.generation.fallbackProvider, "submit");
      vi.spyOn(t.generation.provider, "reconcile").mockResolvedValue(null);
      const job = t.runs.job(t.context, t.run.id, step.id);
      const rejected = status === 400;
      const message = "Provider invalid (HTTP 400, INVALID_ARGUMENT)";
      if (rejected) await expect(t.engine.process(job)).resolves.toBeNull();
      else await expect(t.engine.process(job)).rejects.toThrow("RECONCILE_REQUIRED");
      expect(await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } })).toMatchObject(
        rejected
          ? {
              state: "FAILED",
              providerJobId: null,
              costMinor: 0,
              error: { code: "PROVIDER_INVALID", message },
            }
          : { state: "RUNNING", providerJobId: null },
      );
      expect(await t.store.get(t.context, t.run.id)).toMatchObject(
        rejected
          ? { state: "GENERATING", pauseReason: null }
          : { state: "GENERATING", pauseReason: expect.stringMatching(/^RECONCILE_REQUIRED/) },
      );
      const ledger = await t.db.providerRequest.findFirstOrThrow({
        where: { workspaceId: t.context.workspaceId, correlationId: step.id },
      });
      expect(ledger).toMatchObject(
        rejected
          ? {
              status: "FAILED",
              errorCode: "NOT_DISPATCHED",
              errorMessage: message,
              responseMetadata: { dispatched: false, costKnown: true },
            }
          : {
              errorCode: "VIDEO_RUN_OUTCOME_UNKNOWN",
              actualCost: null,
              responseMetadata: { dispatched: true, costKnown: false },
            },
      );
      if (rejected) expect(ledger.actualCost?.toString()).toBe("0");
      const reservation = await t.db.usageReservation.findFirstOrThrow({
        where: { workspaceId: t.context.workspaceId, correlationId: step.id },
      });
      expect(reservation).toMatchObject({
        status: rejected ? "RELEASED" : "RESERVED",
        committedMinor: null,
      });
      expect(
        await db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
      ).toMatchObject({
        reservedMinor: rejected ? 0 : Number(reservation.amountMinor),
        spentMinor: 0,
      });
      const events = await t.store.events(t.context, t.run.id, 0);
      expect(events.some((event) => event.type === "reconcile_required")).toBe(!rejected);
      await expect(t.engine.process(job)).resolves.toBeNull();
      expect(submit).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
    },
    15000,
  );
  it("keeps admission durable before invoking a provider", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const db = t.store.scoped(t.context);
    const step = await db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0" },
    });
    const envelope = (): Promise<Prisma.BudgetEnvelopeGetPayload<object>> =>
      db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    const before = await envelope();
    const estimate = t.generation.provider.estimate(
      ShotSpecSchema.parse(step.input),
      before.route === "FALLBACK",
    );
    expect(estimate).toBeGreaterThan(0);
    expect(before).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    const reservations = (): Promise<Prisma.UsageReservationGetPayload<object>[]> =>
      t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } });
    expect(await reservations()).toEqual([]);
    const hold = vi.spyOn(t.usage, "reserve");
    const charge = vi.spyOn(t.usage, "commit");
    const release = vi.spyOn(t.usage, "release");
    const submit = vi.spyOn(t.generation.provider, "submit");
    const reconcile = vi.spyOn(t.generation.provider, "reconcile").mockResolvedValue(null);
    const job = t.runs.job(t.context, t.run.id, step.id);
    const mutate = t.store.mutate.bind(t.store);
    const failure = vi.spyOn(t.store, "mutate").mockImplementation((context, id, type, work) =>
      mutate(context, id, type, async (scoped, run, tx) => {
        const result = await work(scoped, run, tx);
        if (type === "provider_dispatch") {
          expect(submit).not.toHaveBeenCalled();
          throw new Error("simulated dispatch transaction failure");
        }
        return result;
      }),
    );
    try {
      await expect(t.engine.process(job)).rejects.toThrow("simulated dispatch transaction failure");
    } finally {
      failure.mockRestore();
    }
    expect(await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } })).toMatchObject({
      state: "PENDING",
      providerJobId: null,
      costMinor: null,
    });
    const request = await t.db.providerRequest.findFirstOrThrow({
      where: { workspaceId: t.context.workspaceId, correlationId: step.id },
    });
    expect(request.errorCode).toBe("ADMISSION_ROLLED_BACK");
    expect(request.actualCost?.toString()).toBe("0");
    expect(await reservations()).toMatchObject([
      {
        idempotencyKey: `m08:${step.idempotencyKey}`,
        status: "RELEASED",
        amountMinor: BigInt(estimate + Math.ceil(estimate / 4)),
        committedMinor: null,
        releaseReason: "NOT_DISPATCHED",
      },
    ]);
    expect(await envelope()).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    expect(submit).not.toHaveBeenCalled();

    await t.control.resume(t.context, t.run.id);
    await expect(t.engine.process(job)).resolves.toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledTimes(2);
    expect(charge).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(await envelope()).toMatchObject({
      reservedMinor: shotReceiptBufferMinor(estimate),
      spentMinor: estimate,
    });
  });
  it("rolls back a shot when a pause interleaves between reserve and admission", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const step = await shotZero(t);
    const submit = vi.spyOn(t.generation.provider, "submit");
    const reconcile = vi.spyOn(t.generation.provider, "reconcile");
    const job = t.runs.job(t.context, t.run.id, step.id);
    const mutate = t.store.mutate.bind(t.store);
    const pause = vi
      .spyOn(t.store, "mutate")
      .mockImplementation(async (context, id, type, work) => {
        if (type === "provider_dispatch")
          await mutate(context, id, "test_pause", async (db) => {
            await db.videoRun.updateMany({
              where: { id },
              data: { state: "PAUSED_BUDGET", pauseReason: "BUDGET_CAP" },
            });
            return { value: null, payload: {} };
          });
        return mutate(context, id, type, work);
      });
    try {
      await expect(t.engine.process(job)).resolves.toBe(12000);
    } finally {
      pause.mockRestore();
    }
    expect(submit).not.toHaveBeenCalled();
    expect(await shotZero(t)).toMatchObject({ state: "PENDING", costMinor: null });
    expect(
      await t.db.usageReservation.findFirstOrThrow({
        where: { workspaceId: t.context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
      }),
    ).toMatchObject({ status: "RELEASED", committedMinor: null });
    expect(
      await t.store.scoped(t.context).budgetEnvelope.findFirst({ where: { runId: t.run.id } }),
    ).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    await t.control.resume(t.context, t.run.id);
    await expect(t.engine.process(job)).resolves.toBeNull();
    expect(submit).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("recovers a recorded job after its step attachment transaction rolls back", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const step = await shotZero(t);
    const submit = vi.spyOn(t.generation.provider, "submit");
    const reconcile = vi.spyOn(t.generation.provider, "reconcile");
    const mutate = t.store.mutate.bind(t.store);
    const failure = vi.spyOn(t.store, "mutate").mockImplementation((context, id, type, work) =>
      mutate(context, id, type, async (db, run, tx) => {
        const result = await work(db, run, tx);
        if (type === "provider_submitted") throw new Error("attachment failed");
        return result;
      }),
    );
    const job = t.runs.job(t.context, t.run.id, step.id);
    try {
      await expect(t.engine.process(job)).rejects.toThrow("attachment failed");
    } finally {
      failure.mockRestore();
    }
    expect(
      (
        await t.db.providerRequest.findFirstOrThrow({
          where: { workspaceId: t.context.workspaceId, correlationId: step.id },
        })
      ).responseMetadata,
    ).toMatchObject({
      providerJobId: expect.any(String),
    });
    await expect(t.engine.process(job)).resolves.toBeNull();
    expect(await shotZero(t)).toMatchObject({ state: "SUCCEEDED" });
    expect(
      (
        await t.db.usageReservation.findFirstOrThrow({
          where: { workspaceId: t.context.workspaceId, correlationId: step.id },
        })
      ).status,
    ).toBe("COMMITTED");
    expect(submit).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
