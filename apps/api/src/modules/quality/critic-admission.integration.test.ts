import { afterEach, describe, expect, it, vi } from "vitest";
import { QualityRubricSchema, ShotSpecSchema, type QualityRubric } from "@reelforge/contracts";
import type { RunsQueue } from "../runs/runs.queue.js";
import { ProviderFailure } from "@reelforge/ai-providers";
import { generateClips, generating, runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Run, Step } from "../runs/runs.types.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { criticReservationCents, criticTextPort } from "./critic-text-port.js";

const rubric: QualityRubric = {
  hook: 8,
  coherence: 8,
  artifacts: 9,
  captionSync: 8,
  briefFit: 9,
  policy: 10,
};
async function sourceId(t: Tenant): Promise<string> {
  return (
    await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0", attempt: 1 },
    })
  ).id;
}
async function criticRun(t: Tenant): Promise<Run> {
  await generating(t);
  return t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
}
type CriticWire = (
  sent?: () => Promise<void>,
) => Promise<{ output: QualityRubric; providerJobId: string; usage: Record<string, unknown> }>;

function critic(
  t: Tenant,
  run: Run,
): {
  accounts: MediaAccounts;
  complete: ReturnType<typeof vi.fn<CriticWire>>;
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
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  const complete = vi.fn<CriticWire>(async (sent) => {
    await sent?.();
    return { output: rubric, providerJobId: "critic-job", usage: {} };
  });
  const ports = {
    get: async () => ({
      text: {
        completePaid: async (
          _spec: unknown,
          dispatchKey: string,
          sent?: () => Promise<void>,
        ): Promise<Awaited<ReturnType<CriticWire>> & { dispatchKey: string }> => ({
          ...(await complete(sent)),
          dispatchKey,
        }),
      },
    }),
  } as unknown as MediaPorts;
  const port = criticTextPort({ access, accounts, ports, context: t.context, run, attempt: 1 });
  const spec = {
    prompt: "review",
    jsonSchema: {},
    parse: (value: unknown): QualityRubric => QualityRubricSchema.parse(value),
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
  it("closes an unarmed critic on cancel without any charge or wire submission", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    vi.spyOn(c.accounts, "dispatchTextAttempt").mockRejectedValueOnce(new Error("worker stopped"));
    await expect(c.review()).rejects.toThrow("worker stopped");
    const [step] = await c.steps();
    const where = { workspaceId: run.workspaceId, attemptId: step!.id };
    expect(await t.db.textAttemptEvidence.findMany({ where })).toMatchObject([
      { kind: "PREPARED" },
    ]);
    expect(await t.db.providerRequest.count({ where: { correlationId: step!.id } })).toBe(0);
    expect(await t.db.usageReservation.count({ where: { correlationId: step!.id } })).toBe(0);
    await t.control.cancel(t.context, run.id);
    expect(
      await t.db.textAttemptEvidence.findMany({ where, orderBy: { sequence: "asc" } }),
    ).toMatchObject([{ kind: "PREPARED" }, { kind: "NOT_DISPATCHED" }]);
    expect(await c.steps()).toMatchObject([{ id: step!.id, state: "CANCELLED" }]);
    expect(c.complete).not.toHaveBeenCalled();
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 0,
    });
  });

  it("surrenders a committed arm whose acknowledgement was lost before transport", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const mutate = t.store.mutate.bind(t.store);
    const spy = vi.spyOn(t.store, "mutate").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[2] === "text_attempt_armed") throw new Error("arm acknowledgement lost");
      return result;
    });
    await expect(c.review()).rejects.toThrow("arm acknowledgement lost");
    spy.mockRestore();
    const [original] = await c.steps();
    const where = { workspaceId: run.workspaceId, correlationId: original!.id };
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "RELEASED",
      committedMinor: null,
    });
    expect(await t.db.providerRequest.findFirstOrThrow({ where })).toMatchObject({
      errorCode: "NOT_DISPATCHED",
      responseMetadata: { dispatched: false },
    });
    expect(c.complete).not.toHaveBeenCalled();
    await expect(c.review()).resolves.toMatchObject({ output: rubric });
    await expect(c.review()).resolves.toMatchObject({ output: rubric });
    expect(c.complete).toHaveBeenCalledOnce();
    expect(await c.steps()).toMatchObject([
      { id: original!.id, state: "CANCELLED", output: { closedBy: "NOT_DISPATCHED" } },
      { attempt: 2, state: "SUCCEEDED" },
    ]);
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: criticReservationCents(),
    });
  });

  it("settles the journaled result without another paid call", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const interrupted = vi
      .spyOn(c.accounts, "complete")
      .mockRejectedValueOnce(new Error("worker stopped"));
    const stage = async (): Promise<QualityRubric> =>
      QualityRubricSchema.parse((await c.review()).output);
    t.planning.handlers = { ...t.planning.handlers, CRITIC: { execute: stage, reconcile: stage } };
    const enqueue = vi.fn<RunsQueue["enqueue"]>();
    t.runs.queue = { enqueue } as unknown as RunsQueue;
    await expect(t.engine.process(t.runs.job(t.context, run.id))).rejects.toThrow("worker stopped");
    interrupted.mockRestore();
    expect(await c.steps()).toMatchObject([
      { state: "WAITING_EXTERNAL", providerJobId: "critic-job", output: { output: rubric } },
    ]);
    await t.engine.recover();
    const recovery = enqueue.mock.calls.find(([job]) => job.runId === run.id && !job.stepId);
    expect(recovery).toBeDefined();
    await t.engine.process(recovery![0]);
    await t.engine.process(recovery![0]);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "AWAITING_APPROVAL",
      pauseReason: null,
    });
    expect(await t.db.runEvent.count({ where: { runId: run.id, type: "media_completed" } })).toBe(
      1,
    );
    expect(c.complete).toHaveBeenCalledOnce();
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: criticReservationCents(),
      reservedMinor: 0,
    });
  });

  it("fences re-edit, replay and reshoot while the journaled transport is in flight", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    c.complete.mockImplementationOnce(async (sent) => {
      await sent?.();
      started.resolve();
      await gate.promise;
      return { providerJobId: "critic-job", output: rubric, usage: {} };
    });
    const reviewing = c.review();
    try {
      await Promise.race([started.promise, reviewing]);
      await Promise.all([
        expect(t.control.reedit(t.context, run.id)).rejects.toThrow("Reconcile"),
        expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED"),
      ]);
      const [step] = await c.steps();
      await expect(t.control.reshoot(t.context, run.id, 0, await sourceId(t))).rejects.toThrow(
        "Reconcile",
      );
      expect(
        await t.db.textAttemptEvidence.findMany({
          where: { workspaceId: run.workspaceId, attemptId: step!.id },
          orderBy: { sequence: "asc" },
        }),
      ).toMatchObject([{ kind: "PREPARED" }, { kind: "ARMED" }, { kind: "SENT_EVIDENCE" }]);
      expect(await t.db.videoRunStep.count({ where: { runId: run.id, key: "REEDIT" } })).toBe(0);
    } finally {
      gate.resolve();
      await reviewing;
    }
    expect(c.complete).toHaveBeenCalledOnce();
  });

  it("blocks a prepared critic after a legacy reshoot wins the run lock", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const dispatch = c.accounts.dispatchTextAttempt.bind(c.accounts);
    vi.spyOn(c.accounts, "dispatchTextAttempt").mockImplementationOnce(async (ctx, step, call) => {
      // Simulate a legacy operator worker that had already won the revision before arm.
      await t.store.mutate(t.context, run.id, "legacy_reshoot_fixture", async (db) => {
        await db.videoRun.updateMany({ where: { id: run.id }, data: { state: "GENERATING" } });
        return { value: null, payload: { from: "CRITIC", to: "GENERATING" } };
      });
      return dispatch(ctx, step, call);
    });
    await expect(c.review()).rejects.toThrow();
    expect(c.complete).not.toHaveBeenCalled();
    const [step] = await c.steps();
    expect(step).toMatchObject({ state: "CANCELLED" });
    expect(
      await t.db.textAttemptEvidence.count({
        where: { workspaceId: run.workspaceId, attemptId: step!.id, kind: "ARMED" },
      }),
    ).toBe(0);
    expect((await t.store.get(t.context, run.id)).state).toBe("GENERATING");
  });

  it("settles a superseded late critic rejection without touching the replacement run", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const c = critic(t, run);
    const started = Promise.withResolvers<void>();
    const transport = Promise.withResolvers<never>();
    c.complete.mockImplementationOnce(async (sent) => {
      await sent?.();
      started.resolve();
      return transport.promise;
    });
    const reviewing = c.review();
    const failure = new ProviderFailure("INVALID", false, 0, {
      status: 400,
      code: "INVALID_ARGUMENT",
    });
    const settled = expect(reviewing).rejects.toBe(failure);
    await Promise.race([started.promise, reviewing]);
    const original = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0", attempt: 1 },
    });
    const replacement = await t.db.videoRunStep.create({
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
    transport.reject(failure);
    await settled;
    const [step] = await c.steps();
    expect(step).toMatchObject({ state: "FAILED", error: { code: "INVALID_ARGUMENT" } });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: step!.id } }),
    ).toMatchObject({
      status: "RELEASED",
      committedMinor: null,
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "GENERATING",
      pauseReason: null,
    });
    expect(
      await t.db.videoRunStep.findUniqueOrThrow({ where: { id: replacement.id } }),
    ).toMatchObject({
      state: "PENDING",
    });
  });

  it("holds an ambiguous critic replay with its original key and both claims", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const lost = new ProviderFailure("OUTAGE", true);
    c.complete.mockImplementationOnce(async (sent) => {
      await sent?.();
      throw lost;
    });
    await expect(c.review()).rejects.toBe(lost);
    const [step] = await c.steps();
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(c.complete).toHaveBeenCalledOnce();
    expect(
      await t.db.textAttemptEvidence.findMany({
        where: { workspaceId: run.workspaceId, attemptId: step!.id },
        orderBy: { sequence: "asc" },
      }),
    ).toMatchObject([
      { kind: "PREPARED" },
      { kind: "ARMED" },
      { kind: "SENT_EVIDENCE" },
      { kind: "SENDER_RETIRED" },
    ]);
    expect(await c.steps()).toMatchObject([
      { idempotencyKey: step!.idempotencyKey, state: "RUNNING" },
    ]);
    expect(await t.db.providerRequest.findFirstOrThrow({ where })).toMatchObject({
      errorCode: "TEXT_AWAITING_EVIDENCE",
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
      error: { code: "INVALID_ARGUMENT" },
    });
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request).toMatchObject({
      errorCode: "INVALID_ARGUMENT",
      responseMetadata: { dispatched: true, costKnown: true },
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
      pauseReason: "INVALID_ARGUMENT",
    });
    expect(c.complete).toHaveBeenCalledOnce();
  });
});
