import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QualityRubricSchema, type QualityRubric } from "@reelforge/contracts";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { LocalAssemblyFailure } from "../composition/local-assembly-failure.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { recordAssemblyFailure } from "../orchestration/assembly-recovery.js";
import { generating, runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Run, RunJob } from "../runs/runs.types.js";
import { criticReservationCents, criticTextPort } from "./critic-text-port.js";

const rubric: QualityRubric = {
  hook: 8,
  coherence: 8,
  artifacts: 9,
  captionSync: 8,
  briefFit: 9,
  policy: 10,
};

type ReviewResult = {
  output: QualityRubric;
  providerJobId: string;
  usage: Record<string, unknown>;
};

function reviewFixture(
  t: Tenant,
  run: Run,
): {
  accounts: ReturnType<typeof bindMedia>["accounts"];
  provider: MockInstance<ReturnType<typeof fakeMediaPorts>["text"]["complete"]>;
  review: () => Promise<ReviewResult>;
  pause: () => Promise<number | null>;
  job: RunJob;
} {
  vi.stubEnv("GEMINI_TEXT_MODEL", "fixture-critic");
  const bytes = Buffer.from("fake critic fixture");
  const native = fakeMediaPorts(
    run.workspaceId,
    t.storage,
    { image: bytes, clip: bytes, audio: bytes },
    [rubric],
  );
  const provider = vi.spyOn(native.text, "complete");
  const { access, accounts, ports } = bindMedia(t, native);
  const critic = criticTextPort({ access, accounts, ports, context: t.context, run, attempt: 1 });
  const spec = {
    prompt: "review",
    jsonSchema: {},
    parse: (value: unknown): QualityRubric => QualityRubricSchema.parse(value),
  };
  const review = (): Promise<ReviewResult> => critic.complete(spec, "critic");
  const stage = async (): Promise<QualityRubric> => (await review()).output;
  t.planning.handlers = { ...t.planning.handlers, CRITIC: { execute: stage, reconcile: stage } };
  const pause = (): Promise<number | null> =>
    recordAssemblyFailure(
      t.runs,
      t.context,
      run,
      new LocalAssemblyFailure("MEDIA_TOOL_UNAVAILABLE", "Render worker lost its encoder"),
    );
  return { accounts, provider, review, pause, job: t.runs.job(t.context, run.id) };
}

describe.skipIf(!process.env.DATABASE_URL)("paid critic after durable render pause", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["intent", "authorization"] as const)(
    "blocks a stale critic worker at the %s boundary without a charge",
    async (cut) => {
      const t = await fixture.tenant();
      await generating(t);
      const run = await t.db.videoRun.update({
        where: { id: t.run.id },
        data: { state: "CRITIC" },
      });
      const { accounts, provider, pause, job } = reviewFixture(t, run);
      if (cut === "intent") {
        const begin = accounts.begin.bind(accounts);
        vi.spyOn(accounts, "begin").mockImplementationOnce(async (...args) => {
          await pause();
          return begin(...args);
        });
      } else {
        const dispatch = accounts.dispatchTextAttempt.bind(accounts);
        vi.spyOn(accounts, "dispatchTextAttempt").mockImplementationOnce(async (...args) => {
          await pause();
          return dispatch(...args);
        });
      }

      await expect(t.engine.process(job)).resolves.toBeNull();
      expect(provider).not.toHaveBeenCalled();
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "CRITIC",
        pauseReason: "MEDIA_TOOL_UNAVAILABLE",
      });
      expect(
        await t.db.videoRunStep.findMany({ where: { runId: run.id, key: "media:text:critic:1" } }),
      ).toMatchObject(cut === "intent" ? [] : [{ state: "CANCELLED" }]);
      expect(
        await t.db.runEvent.count({ where: { runId: run.id, type: "text_attempt_armed" } }),
      ).toBe(0);
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: run.workspaceId } }),
      ).toEqual([]);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({
        spentMinor: 0,
        reservedMinor: 0,
      });
    },
  );

  it("settles a critic result admitted before the pause without resubmitting", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const run = await t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
    const { accounts, provider, pause, review, job } = reviewFixture(t, run);
    vi.spyOn(accounts, "complete").mockImplementationOnce(async () => {
      await pause();
      throw new Error("worker stopped after recording the critic result");
    });
    await expect(t.engine.process(job)).rejects.toThrow("worker stopped after recording");
    const where = { runId: run.id, key: "media:text:critic:1" };
    expect(await t.db.videoRunStep.findFirst({ where })).toMatchObject({
      state: "WAITING_EXTERNAL",
      output: { output: rubric },
    });

    await expect(review()).resolves.toMatchObject({ output: rubric });
    await expect(review()).resolves.toMatchObject({ output: rubric });
    expect(provider).toHaveBeenCalledOnce();
    expect(await t.db.videoRunStep.findFirst({ where })).toMatchObject({ state: "SUCCEEDED" });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: criticReservationCents(),
      reservedMinor: 0,
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "CRITIC",
      pauseReason: "MEDIA_TOOL_UNAVAILABLE",
    });
  });
});
