import { afterEach, describe, expect, it, vi } from "vitest";
import { ShotSpecSchema } from "@reelforge/contracts";
import { z } from "zod";
import { ProviderFailure } from "@reelforge/ai-providers";
import { generateClips, generating, runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Run, Step } from "../runs/runs.types.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { criticReservationCents, criticTextPort } from "./critic-text-port.js";

async function criticRun(t: Tenant): Promise<Run> {
  await generating(t);
  return t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
}
function critic(
  t: Tenant,
  run: Run,
): {
  accounts: MediaAccounts;
  complete: ReturnType<
    typeof vi.fn<() => Promise<{ output: number; providerJobId: string; usage: object }>>
  >;
  review: () => ReturnType<ReturnType<typeof criticTextPort>["complete"]>;
  steps: () => Promise<Step[]>;
} {
  const access = {
    runs: t.runs,
    paid: new RunPaidCalls(t.usage, t.store),
    artifacts: t.artifacts,
    boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
  } as MediaAccess;
  const accounts = new MediaAccounts(access);
  const complete = vi.fn(async () => ({ output: 8, providerJobId: "critic-job", usage: {} }));
  const ports = { get: async () => ({ text: { complete } }) } as unknown as MediaPorts;
  const port = criticTextPort({ access, accounts, ports, context: t.context, run, attempt: 1 });
  const spec = {
    prompt: "review",
    jsonSchema: {},
    parse: (value: unknown): number => z.number().parse(value),
  };
  return {
    accounts,
    complete,
    review: () => port.complete(spec, "critic"),
    steps: (): Promise<Step[]> =>
      t.db.videoRunStep.findMany({
        where: { runId: run.id, key: "media:text:critic:1" },
        orderBy: { attempt: "asc" },
      }),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!process.env.DATABASE_URL)("critic text admission recovery", () => {
  const fixture = runsFixture();
  it.each(["intent", "reserved"] as const)(
    "rolls back the %s at zero before retrying once",
    async (cut) => {
      vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
      const t = await fixture.tenant();
      const run = await criticRun(t);
      const c = critic(t, run);
      vi.spyOn(c.accounts, cut === "intent" ? "prepare" : "dispatchText").mockRejectedValueOnce(
        new Error("worker stopped"),
      );
      await expect(c.review()).rejects.toThrow("worker stopped");
      const [original] = await c.steps();
      const where = { workspaceId: run.workspaceId, correlationId: original!.id };
      expect(await t.db.providerRequest.count({ where })).toBe(cut === "intent" ? 0 : 1);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: criticReservationCents(), spentMinor: 0 });
      expect(c.complete).not.toHaveBeenCalled();
      await expect(c.review()).resolves.toMatchObject({ output: 8 });
      await expect(c.review()).resolves.toMatchObject({ output: 8 });
      expect(c.complete).toHaveBeenCalledOnce();
      expect(await c.steps()).toMatchObject([
        { id: original!.id, state: "CANCELLED", output: { closedBy: "NOT_DISPATCHED" } },
        { attempt: 2, state: "SUCCEEDED" },
      ]);
      if (cut === "reserved") {
        const request = await t.db.providerRequest.findFirstOrThrow({ where });
        expect(request.errorCode).toBe("NOT_DISPATCHED");
        expect(request.actualCost?.toNumber()).toBe(0);
        expect(
          await t.db.usageReservation.findFirstOrThrow({
            where: { idempotencyKey: `m08:${original!.idempotencyKey}` },
          }),
        ).toMatchObject({ status: "RELEASED", committedMinor: null });
      } else expect(await t.db.providerRequest.count({ where })).toBe(0);
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: original!.id, type: "provider_dispatch" },
        }),
      ).toBe(0);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 0, spentMinor: criticReservationCents() });
      expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
    },
  );

  it("settles the saved result after attachJob without another paid call", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const interrupted = vi
      .spyOn(c.accounts, "complete")
      .mockRejectedValueOnce(new Error("worker stopped"));
    await expect(c.review()).rejects.toThrow("worker stopped");
    interrupted.mockRestore();
    expect(await c.steps()).toMatchObject([
      { state: "WAITING_EXTERNAL", providerJobId: "critic-job", output: { output: 8 } },
    ]);
    await c.review();
    await c.review();
    expect(c.complete).toHaveBeenCalledOnce();
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: criticReservationCents(),
      reservedMinor: 0,
    });
  });

  it("fences re-edit and replay after the dispatch marker and holds a legacy job without output", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    c.complete.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      return { providerJobId: "critic-job", output: 8, usage: {} };
    });
    const reviewing = c.review();
    try {
      await Promise.race([started.promise, reviewing]);
      await Promise.all([
        expect(t.control.reedit(t.context, run.id)).rejects.toThrow("Reconcile"),
        expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED"),
      ]);
      const [step] = await c.steps();
      await t.runs.attachJob(t.context, step!, "critic-job");
      await expect(t.control.reshoot(t.context, run.id, 0)).rejects.toThrow("Reconcile");
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Reconcile");
      expect((await t.store.get(t.context, run.id)).pauseReason).toContain(step!.id);
      expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: "REEDIT" } })).toBe(0);
    } finally {
      gate.resolve();
      await reviewing;
    }
    expect(c.complete).toHaveBeenCalledOnce();
  });

  it("blocks a prepared critic at dispatch after a reshoot wins the run lock", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const dispatch = c.accounts.dispatchText.bind(c.accounts);
    vi.spyOn(c.accounts, "dispatchText").mockImplementationOnce(async (ctx, step, call) => {
      await t.control.reshoot(t.context, run.id, 0);
      return dispatch(ctx, step, call);
    });
    await expect(c.review()).rejects.toThrow();
    expect(c.complete).not.toHaveBeenCalled();
    expect(await c.steps()).toMatchObject([{ state: "CANCELLED" }]);
    expect((await t.store.get(t.context, run.id)).state).toBe("GENERATING");
  });

  it("collects an accepted legacy reshoot before terminalizing a late critic rejection", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<never>();
    c.complete.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const review = c.review();
    const failure = new ProviderFailure("INVALID", false);
    const settled = expect(review).rejects.toBe(failure);
    await Promise.race([started.promise, review]);
    const original = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    // Legacy command bypassed the critic fence; the replacement is already accepted.
    const shot = await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key: original.key,
        attempt: 2,
        input: ShotSpecSchema.parse(original.input),
        idempotencyKey: `${run.id}:0:2`,
      },
    });
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "GENERATING" } });
    vi.spyOn(t.generation.provider, "poll").mockResolvedValueOnce("running");
    const job = t.runs.job(t.context, run.id, shot.id);
    try {
      await expect(t.engine.process(job)).resolves.toBe(12000);
    } finally {
      gate.reject(failure);
      await settled;
    }
    expect((await t.store.get(t.context, run.id)).state).toBe("GENERATING");
    await t.engine.process(job);
    expect((await t.store.get(t.context, run.id)).state).toBe("FAILED");
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
    ).toMatchObject({ status: "COMMITTED" });
    expect(
      (await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).reservedMinor,
    ).toBe(0);
  });

  it("holds an ambiguous critic replay with its original key and both claims", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    vi.spyOn(c.accounts, "dispatchText").mockRejectedValueOnce(new Error("worker stopped"));
    await expect(c.review()).rejects.toThrow("worker stopped");
    const [step] = await c.steps();
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    await t.db.providerRequest.updateMany({
      where,
      data: { responseMetadata: { dispatched: false } },
    });
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(c.complete).not.toHaveBeenCalled();
    expect(await c.steps()).toMatchObject([
      { idempotencyKey: step!.idempotencyKey, state: "RUNNING" },
    ]);
    expect(await t.db.providerRequest.findFirstOrThrow({ where })).toMatchObject({
      errorCode: "VIDEO_RUN_OUTCOME_UNKNOWN",
      actualCost: null,
    });
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "RESERVED",
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: criticReservationCents(),
      spentMinor: 0,
    });
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(step!.id);
  });

  it("finalizes a definitive INVALID_ARGUMENT rejection without operator action", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const failure = new ProviderFailure("INVALID", false, 0, {
      status: 400,
      code: "INVALID_ARGUMENT",
    });
    c.complete.mockRejectedValueOnce(failure);
    await expect(c.review()).rejects.toBe(failure);
    await expect(c.review()).rejects.toThrow("Critic provider request was rejected");
    const [step] = await c.steps();
    expect(step).toMatchObject({
      state: "FAILED",
      costMinor: 0,
      error: { code: "PROVIDER_INVALID" },
    });
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request).toMatchObject({
      errorCode: "NOT_DISPATCHED",
      responseMetadata: { dispatched: false, costKnown: true },
    });
    expect(request.actualCost?.toNumber()).toBe(0);
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "RELEASED",
      committedMinor: null,
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 0,
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_INVALID",
    });
    expect(c.complete).toHaveBeenCalledOnce();
  });
});
