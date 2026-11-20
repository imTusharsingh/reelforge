import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderFailure, ProviderHttp } from "@reelforge/ai-providers";
import type { Prisma } from "@reelforge/database";
import { ShotSpecSchema, VIDEO_RUN_TRANSITIONS } from "@reelforge/contracts";
import { runsFixture, generating, generateClips } from "./runs.fixture.js";

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
    for (let i = 0; i < 3; i++) await t.engine.process(t.runs.job(t.context, t.run.id));
    const run = await t.store.get(t.context, t.run.id);
    expect(run.state).toBe("AWAITING_APPROVAL");
    expect(submit).toHaveBeenCalledTimes(6);
    const detail = await t.runs.detail(t.context, run.id);
    expect(detail).toMatchObject({ envelope: { reservedMinor: 0, spentMinor: 318 } });
    await t.control.approve(t.context, run.id);
    expect((await t.store.get(t.context, run.id)).state).toBe("SCHEDULED");
    await expect(t.control.approve(t.context, run.id)).rejects.toThrow();
    expect(
      await t.store
        .scoped(t.context)
        .runEvent.count({ where: { runId: run.id, type: "approved" } }),
    ).toBe(1);
    const events = await t.store.events(t.context, run.id, 0);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    const states = events.filter((e) => e.type === "transition").map((e) => e.payload);
    expect(states.length).toBe(6);
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
  it("refuses over-$8 estimates before media dispatch", async () => {
    const t = await fixture.tenant("L2", 180);
    const submit = vi.spyOn(t.generation.provider, "submit");
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await expect(t.engine.process(t.runs.job(t.context, t.run.id))).rejects.toThrow("$8");
    expect(submit).not.toHaveBeenCalled();
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
    const t = await fixture.tenant();
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
    expect(finished.reservedMinor).toBe(0);
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
  it.each([400, 503, "network"] as const)(
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
      else
        fetcher.mockResolvedValue(
          new Response(
            JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "key=private" } }),
            { status },
          ),
        );
      const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
      const submit = vi.spyOn(t.generation.provider, "submit").mockImplementation(async () => {
        await http.json("interactions", { prompt: "fixture" });
        throw new Error("Unexpected successful response");
      });
      const job = t.runs.job(t.context, t.run.id, step.id);
      const rejected = status === 400;
      const message = "Provider invalid (HTTP 400, INVALID_ARGUMENT)";
      await expect(t.engine.process(job)).rejects.toThrow(
        rejected ? message : "RECONCILE_REQUIRED",
      );
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
          ? { state: "FAILED", pauseReason: "PROVIDER_INVALID" }
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
    },
    15000,
  );
  it("holds for reconciliation after a dispatch transaction rolls back", async () => {
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
          expect(submit).toHaveBeenCalledTimes(1);
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
      state: "RUNNING",
      providerJobId: null,
    });
    expect(
      await t.db.providerRequest.findFirstOrThrow({
        where: { workspaceId: t.context.workspaceId, correlationId: step.id },
      }),
    ).toMatchObject({ errorCode: "PENDING" });

    const held = await reservations();
    expect(held).toMatchObject([
      {
        idempotencyKey: `m08:${step.idempotencyKey}`,
        correlationId: step.id,
        status: "RESERVED",
        currency: "USD",
        amountMinor: BigInt(estimate),
        committedMinor: null,
        committedAt: null,
        releasedAt: null,
        releaseReason: null,
      },
    ]);
    const heldEnvelope = await envelope();
    expect(heldEnvelope).toEqual({
      ...before,
      reservedMinor: estimate,
      revision: before.revision + 1,
      updatedAt: heldEnvelope.updatedAt,
    });

    await t.control.resume(t.context, t.run.id);
    await expect(t.engine.process(job)).rejects.toThrow("RECONCILE_REQUIRED");
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(step.idempotencyKey);
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      pauseReason: `RECONCILE_REQUIRED: submission outcome unknown (${step.id})`,
    });
    expect(await reservations()).toEqual(held);
    expect(await envelope()).toEqual(heldEnvelope);
    await expect(t.engine.process(job)).resolves.toBeNull();
    expect(await reservations()).toEqual(held);
    expect(await envelope()).toEqual(heldEnvelope);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(charge).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
