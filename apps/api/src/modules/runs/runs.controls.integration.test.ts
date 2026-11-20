import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, generating, generateClips } from "./runs.fixture.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { ProviderHttp } from "@reelforge/ai-providers";
import { ArtifactSchema } from "./runs.types.js";

const suite = describe.skipIf(!process.env.DATABASE_URL);
suite("V3 approval, caps and retention", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it.each(["SCRIPTING", "GENERATING"] as const)(
    "cancels from %s and skips queued work",
    async (state) => {
      const t = await fixture.tenant();
      if (state === "SCRIPTING") await t.engine.process(t.runs.job(t.context, t.run.id));
      else await generating(t);
      const db = t.store.scoped(t.context);
      expect((await t.store.get(t.context, t.run.id)).state).toBe(state);
      const step = await db.videoRunStep.create({
        data: {
          workspaceId: t.context.workspaceId,
          runId: t.run.id,
          key: "media:text:fixture",
          state: "RUNNING",
          costMinor: 10,
          idempotencyKey: `${t.run.id}:text:1`,
          input: {},
        },
      });
      const usage = new UsageBudgetService(t.db, () => new Date());
      const paid = new RunPaidCalls(usage, t.store);
      await paid.reserve(t.context, t.run, step, 10);
      const submit = vi.spyOn(t.generation.provider, "submit");
      await t.control.cancel(t.context, t.run.id);
      await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).resolves.toBeNull();
      expect(submit).not.toHaveBeenCalled();
      const breakdown = await usage.runBreakdown(t.context, t.run.id);
      expect(breakdown.reservations).toEqual([
        expect.objectContaining({ status: "RELEASED", committedMinor: null }),
      ]);
      await expect(t.control.cancel(t.context, t.run.id)).rejects.toMatchObject({ status: 409 });
      expect((await t.store.get(t.context, t.run.id)).state).toBe("CANCELED");
    },
  );
  it("blocks a shot if cancel lands while its provider inputs are being prepared", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const step = await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0" },
    });
    const fetcher = vi.fn<typeof fetch>();
    const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    t.generation.resolvePorts = async (): ReturnType<
      NonNullable<typeof t.generation.resolvePorts>
    > => {
      preparing.resolve();
      await prepared.promise;
      return {
        primary: Object.assign(t.generation.provider, { assertKey: (): void => http.assertKey() }),
        fallback: t.generation.fallbackProvider,
      };
    };
    const submit = vi.spyOn(t.generation.provider, "submit").mockImplementation(async () => {
      await http.json("interactions", {});
      return { providerJobId: "fixture-job" };
    });
    const queued = t.engine.process(t.runs.job(t.context, t.run.id, step.id));
    await preparing.promise;
    await t.control.cancel(t.context, t.run.id);
    prepared.resolve();
    await expect(queued).rejects.toThrow("Run is not generating");
    expect(submit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects the selected provider key before reserving a shot", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const step = await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const fetcher = vi.fn<typeof fetch>();
    const http = new ProviderHttp("placeholder", "gemini", fetcher);
    const primary = Object.assign(t.generation.provider, {
      assertKey: (): void => http.assertKey(),
    });
    const submit = vi.spyOn(primary, "submit");
    t.generation.resolvePorts = async (): ReturnType<
      NonNullable<typeof t.generation.resolvePorts>
    > => ({
      primary,
      fallback: t.generation.fallbackProvider,
    });

    await expect(t.generation.process(t.context, run, step.id)).rejects.toMatchObject({
      kind: "INVALID_KEY",
      dispatched: false,
    });
    expect(await t.db.providerRequest.count({ where: { correlationId: step.id } })).toBe(0);
    expect(
      await t.db.usageReservation.count({
        where: { workspaceId: t.context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
      }),
    ).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("settles a call admitted before cancel and rejects a subsequent dispatch", async () => {
    const t = await fixture.tenant();
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const step = await t.store.scoped(t.context).videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        key: "media:text:fixture",
        state: "RUNNING",
        costMinor: 10,
        idempotencyKey: `${t.run.id}:text:1`,
        input: {},
      },
    });
    const usage = new UsageBudgetService(t.db, () => new Date());
    const paid = new RunPaidCalls(usage, t.store);
    await paid.reserve(t.context, t.run, step, 10);
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<number>();
    const dispatched = paid.dispatch(t.context, step, () => {
      started.resolve();
      return completed.promise;
    });
    await started.promise;
    await t.control.cancel(t.context, t.run.id);
    expect((await usage.runBreakdown(t.context, t.run.id)).totals.currencies[0]).toMatchObject({
      reservedMinor: 10,
      committedMinor: 0,
    });
    completed.resolve(7);
    await paid.finish(t.context, step, true, await dispatched);
    const provider = vi.fn();
    await expect(paid.dispatch(t.context, step, provider)).rejects.toThrow(
      "Paid dispatch is closed",
    );
    expect(provider).not.toHaveBeenCalled();
    expect((await usage.runBreakdown(t.context, t.run.id)).totals.currencies[0]).toMatchObject({
      reservedMinor: 0,
      committedMinor: 7,
    });
  });
  it("releases an unknown text attempt and resumes the same stage", async () => {
    const t = await fixture.tenant();
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const db = t.store.scoped(t.context);
    const step = await db.videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        key: "media:text:fixture",
        state: "RUNNING",
        costMinor: 12,
        idempotencyKey: `${t.run.id}:text:1`,
        input: {},
      },
    });
    const usage = new UsageBudgetService(t.db, () => new Date());
    const paid = new RunPaidCalls(usage, t.store);
    await paid.reserve(t.context, t.run, step, 12);
    await db.videoRun.updateMany({
      where: { id: t.run.id },
      data: { pauseReason: "RECONCILE_REQUIRED: text submission outcome unknown" },
    });
    await expect(t.control.resume(t.context, t.run.id)).rejects.toMatchObject({ status: 409 });
    await t.control.abandon(t.context, t.run.id, step.id);
    expect((await usage.runBreakdown(t.context, t.run.id)).totals.currencies[0]).toMatchObject({
      reservedMinor: 0,
      committedMinor: 0,
    });
    await t.control.resume(t.context, t.run.id);
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      state: "SCRIPTING",
      pauseReason: null,
    });
    const resumed = await t.store.get(t.context, t.run.id);
    const accounts = new MediaAccounts({
      runs: t.runs,
      boundary: { check: vi.fn() },
    } as unknown as MediaAccess);
    const next = await accounts.begin(t.context, resumed, step.key, {}, 12, "fixture");
    expect(next).toMatchObject({ attempt: 2, state: "RUNNING" });
    expect(next.idempotencyKey).not.toBe(step.idempotencyKey);
  });
  it("reports reserved and committed VideoRun costs", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const step = await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0" },
    });
    const usage = new UsageBudgetService(t.db, () => new Date());
    const paid = new RunPaidCalls(usage, t.store);
    await paid.reserve(t.context, t.run, step, 25);
    expect((await usage.runBreakdown(t.context, t.run.id)).totals.currencies[0]).toMatchObject({
      reservedMinor: 25,
      committedMinor: 0,
    });
    await paid.finish(t.context, step, true, 20);
    const result = await usage.runBreakdown(t.context, t.run.id);
    expect(result.videoRunId).toBe(t.run.id);
    expect(result.totals.currencies[0]).toMatchObject({ reservedMinor: 0, committedMinor: 20 });
  });
  it("limits full re-edits to one and shot reshoots to two", async () => {
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("CRITIC");
    await t.control.reedit(t.context, t.run.id);
    await expect(t.control.reedit(t.context, t.run.id)).rejects.toThrow("one full re-edit");
    // Give both reshoots enough room. All new paid calls still use M18 and the envelope.
    for (let i = 0; i < 2; i++) {
      await t.control.reshoot(t.context, t.run.id, 0);
      await generateClips(t);
      await t.engine.process(t.runs.job(t.context, t.run.id));
      await t.engine.process(t.runs.job(t.context, t.run.id));
    }
    await t.control.reshoot(t.context, t.run.id, 0);
    expect((await t.store.get(t.context, t.run.id)).state).toBe("NEEDS_HUMAN");
    await t.control.resume(t.context, t.run.id);
    await expect(t.control.resume(t.context, t.run.id)).rejects.toThrow();
  });
  it("keeps final and manifest forever and expires draft storage after 14 days", async () => {
    const t = await fixture.tenant();
    const now = Date.now();
    const draft = await t.artifacts.put(
      t.context,
      "keyframes",
      Buffer.from("draft"),
      "application/json",
    );
    const final = await t.artifacts.put(
      t.context,
      "final",
      Buffer.from("draft"),
      "application/json",
    );
    const manifest = await t.artifacts.put(
      t.context,
      "manifest",
      Buffer.from("manifest"),
      "application/json",
    );
    expect(final.expiresAt).toBeNull();
    expect(manifest.expiresAt).toBeNull();
    const step = await t.store.scoped(t.context).videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        key: "retention",
        idempotencyKey: `${t.run.id}:retention`,
        input: {},
        output: { storageArtifacts: [draft, final, manifest] },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 86400000);
    try {
      await t.artifacts.sweep(t.context);
      await expect(
        t.storage.getObject({ workspaceId: t.context.workspaceId, objectKey: draft.objectKey }),
      ).rejects.toThrow();
      expect(
        await t.storage.getObject({
          workspaceId: t.context.workspaceId,
          objectKey: final.objectKey,
        }),
      ).toEqual(Buffer.from("draft"));
      expect(
        t.artifacts.views(t.context, t.run.id, step.id, [draft, final, manifest]),
      ).toHaveLength(2);
      const expired = { ...draft, expiresAt: new Date(now - 1).toISOString() };
      expect(ArtifactSchema.parse(expired).kind).toBe("keyframes");
    } finally {
      clock.mockRestore();
    }
  });
  it("resumes a cap-refused shot without leaking a reservation or reconciling an unpaid call", async () => {
    const t = await fixture.tenant();
    await generating(t);
    await t.db.usageBudget.updateMany({
      where: { workspaceId: t.context.workspaceId },
      data: { dailyLimitMinor: 1n },
    });
    const submit = vi.spyOn(t.generation.provider, "submit");
    const reconcile = vi.spyOn(t.generation.provider, "reconcile");
    const step = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key: "shot-0" } });
    await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect((await t.store.get(t.context, t.run.id)).state).toBe("PAUSED_BUDGET");
    expect(
      await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
    ).toMatchObject({
      state: "PENDING",
      costMinor: null,
      providerId: null,
      providerJobId: null,
      startedAt: null,
    });
    expect(
      await t.store
        .scoped(t.context)
        .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    expect(
      await t.db.usageReservation.count({
        where: { workspaceId: t.context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
      }),
    ).toBe(0);
    expect(
      await t.db.providerRequest.count({
        where: { workspaceId: t.context.workspaceId, correlationId: step.id },
      }),
    ).toBe(0);
    await t.db.usageBudget.updateMany({
      where: { workspaceId: t.context.workspaceId },
      data: { dailyLimitMinor: 2000n },
    });
    await t.control.resume(t.context, t.run.id);
    await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    const finished = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    expect(finished.state).toBe("SUCCEEDED");
    expect(
      await t.store
        .scoped(t.context)
        .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ reservedMinor: 0, spentMinor: finished.costMinor });
    await generateClips(t);
    for (let i = 0; i < 3; i++) await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("AWAITING_APPROVAL");
  });
});
