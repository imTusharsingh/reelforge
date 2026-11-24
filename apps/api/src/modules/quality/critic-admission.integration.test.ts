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
function critic(
  t: Tenant,
  run: Run,
): {
  accounts: MediaAccounts;
  complete: ReturnType<
    typeof vi.fn<() => Promise<{ output: QualityRubric; providerJobId: string; usage: object }>>
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
  const complete = vi.fn(async () => ({ output: rubric, providerJobId: "critic-job", usage: {} }));
  const ports = { get: async () => ({ text: { complete } }) } as unknown as MediaPorts;
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
  it.each(["intent", "reserved", "swept"] as const)(
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
      if (cut === "swept")
        expect(
          await t.usage.sweepExpiredReservations(new Date(Date.now() + 86400001), run.workspaceId),
        ).toBe(1);
      expect(c.complete).not.toHaveBeenCalled();
      await expect(c.review()).resolves.toMatchObject({ output: rubric });
      await expect(c.review()).resolves.toMatchObject({ output: rubric });
      expect(c.complete).toHaveBeenCalledOnce();
      expect(await c.steps()).toMatchObject([
        { id: original!.id, state: "CANCELLED", output: { closedBy: "NOT_DISPATCHED" } },
        { attempt: 2, state: "SUCCEEDED" },
      ]);
      if (cut !== "intent") {
        const request = await t.db.providerRequest.findFirstOrThrow({ where });
        expect(request.errorCode).toBe("NOT_DISPATCHED");
        expect(request.actualCost?.toNumber()).toBe(0);
        expect(
          await t.db.usageReservation.findFirstOrThrow({
            where: { idempotencyKey: `m08:${original!.idempotencyKey}` },
          }),
        ).toMatchObject({ status: cut === "swept" ? "EXPIRED" : "RELEASED", committedMinor: null });
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
      await t.runs.attachJob(t.context, step!, "critic-job");
      await expect(t.control.reshoot(t.context, run.id, 0, await sourceId(t))).rejects.toThrow(
        "Reconcile",
      );
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
      await t.control.reshoot(t.context, run.id, 0, await sourceId(t));
      return dispatch(ctx, step, call);
    });
    await expect(c.review()).rejects.toThrow();
    expect(c.complete).not.toHaveBeenCalled();
    expect(await c.steps()).toMatchObject([{ state: "CANCELLED" }]);
    expect((await t.store.get(t.context, run.id)).state).toBe("GENERATING");
  });

  it.each(["pending", "prepared", "accepted"])(
    "drains only dispatched reshoots on late critic rejection at %s",
    async (cut) => {
      vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
      const t = await fixture.tenant();
      await generating(t);
      await generateClips(t);
      const run = await t.db.videoRun.update({
        where: { id: t.run.id },
        data: { state: "CRITIC" },
      });
      const c = critic(t, run);
      const retainedClipBuffer = 6 * (105 - 53);
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
      const submit = vi.spyOn(t.generation.provider, "submit");
      const dispatch = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<void>();
      let worker: Promise<number | null> | undefined;
      try {
        if (cut === "prepared") {
          const originalDispatch = RunPaidCalls.prototype.dispatch;
          vi.spyOn(RunPaidCalls.prototype, "dispatch").mockImplementationOnce(async function <T>(
            this: RunPaidCalls,
            ctx: typeof t.context,
            step: Step,
            call: () => Promise<T>,
          ): Promise<T> {
            prepared.resolve();
            await dispatch.promise;
            return originalDispatch.call(this, ctx, step, call) as Promise<T>;
          });
          worker = t.engine.process(job);
          await Promise.race([worker, prepared.promise]);
        } else if (cut === "accepted") await expect(t.engine.process(job)).resolves.toBe(12000);
      } finally {
        gate.reject(failure);
        await settled;
        dispatch.resolve();
      }
      if (cut !== "accepted") {
        if (worker) {
          try {
            await expect(worker).resolves.toBeNull();
          } finally {
            vi.mocked(RunPaidCalls.prototype.dispatch).mockRestore();
          }
        }
        await t.engine.process(t.runs.job(t.context, run.id));
        await t.engine.process(job);
        expect(submit).not.toHaveBeenCalled();
        expect((await t.store.get(t.context, run.id)).state).toBe("FAILED");
        expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject(
          { state: "CANCELLED" },
        );
        if (cut === "prepared") {
          expect(
            await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
          ).toMatchObject({ status: "RELEASED" });
          expect(
            await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: shot.id } }),
          ).toMatchObject({ errorCode: "CRITIC_REJECTED" });
        }
        expect(
          (await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).reservedMinor,
        ).toBe(retainedClipBuffer);
        return;
      }
      expect((await t.store.get(t.context, run.id)).state).toBe("GENERATING");
      await t.engine.process(job);
      expect((await t.store.get(t.context, run.id)).state).toBe("FAILED");
      expect(
        await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
      ).toMatchObject({ status: "COMMITTED" });
      expect(
        (await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).reservedMinor,
      ).toBe(retainedClipBuffer + (105 - 53));
    },
  );

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
