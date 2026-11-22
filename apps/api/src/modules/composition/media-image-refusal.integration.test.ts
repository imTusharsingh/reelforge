import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interactions, NanoBanana, ProviderHttp, SubmissionRefused } from "@reelforge/ai-providers";
import type { RunJob } from "../runs/runs.types.js";
import { generating, runsFixture } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-fixture.fixture.js";

const narrator = {
  providerId: "gemini" as const,
  voiceId: "narrator",
  language: "English",
  pace: 1,
};
const mediaBytes = {
  audio: Buffer.from("audio"),
  image: Buffer.from("image"),
  clip: Buffer.from("clip"),
};

function imagePort(http: typeof fetch): NanoBanana {
  return new NanoBanana(
    new Interactions(new ProviderHttp("AIza" + "abc".repeat(12), "gemini", http), {
      save: async (): Promise<never> => {
        throw new Error("Unexpected download");
      },
    }),
    "image",
  );
}

function refusedImage(): Response {
  return Response.json({ status: "failed", id: "refused-image", error: { code: "safety" } });
}

describe.skipIf(!process.env.DATABASE_URL)("required image refusal", () => {
  const fixture = runsFixture();
  beforeEach(() => {
    for (const key of ["VIDEO", "IMAGE", "TEXT"])
      vi.stubEnv(`GEMINI_${key}_MODEL`, `fixture-${key}`);
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["style reference", "keyframe"] as const)(
    "settles a refused %s and its parent",
    async (kind) => {
      const frame = kind === "keyframe";
      const t = await fixture.tenant("L2", 30, narrator, frame);
      const run = frame ? await generating(t) : t.run;
      const db = t.store.scoped(t.context);
      const job = t.runs.job(t.context, run.id);
      const shots = shotsFixture({ ...planningFixture(), runId: run.id, brief: t.brief }).map(
        (shot) => ({ ...shot, workspaceId: run.workspaceId, durationSeconds: 5 }),
      );
      const native = fakeMediaPorts(run.workspaceId, t.storage, mediaBytes, [
        scriptFixture(),
        shots,
        { character: null, styleFrame: "Leaves", keyframePrompts: shots.map(() => "Leaf") },
      ]);
      const { planning } = bindMedia(t, native);
      const rows = await db.videoRunStep.findMany({
        where: { runId: run.id, key: { startsWith: "shot-" } },
        orderBy: { key: "asc" },
      });
      const original = native.image;
      if (frame) {
        vi.spyOn(original, "poll").mockResolvedValueOnce("running");
        expect(await t.engine.process({ ...job, stepId: rows[1]!.id })).toBe(12000);
      } else await t.engine.process(job);
      const http = vi.fn<typeof fetch>().mockResolvedValueOnce(refusedImage());
      native.image = imagePort(http);
      const work = frame ? { ...job, stepId: rows[0]!.id } : job;
      if (frame) await expect(t.engine.process(work)).rejects.toBeInstanceOf(SubmissionRefused);
      else {
        // This worker has read SCRIPTING and checked the saved plan, but has not claimed it.
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const saved = planning.saved.bind(planning);
        vi.spyOn(planning, "saved").mockImplementationOnce(async (...args) => {
          const result = await saved(...args);
          ready.resolve();
          await release.promise;
          return result;
        });
        const stale = expect(t.engine.process(job)).rejects.toThrow("Planning manifest failed");
        await ready.promise;
        try {
          await expect(t.engine.process(job)).rejects.toBeInstanceOf(SubmissionRefused);
        } finally {
          release.resolve();
          await stale;
        }
      }
      const image = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, providerJobId: "refused-image" },
      });
      expect(image).toMatchObject({ state: "FAILED", costMinor: 4 });
      expect(
        await t.db.providerRequest.findFirst({ where: { correlationId: image.id } }),
      ).toMatchObject({
        responseMetadata: { dispatched: true, providerJobId: "refused-image" },
      });
      expect(
        await t.db.usageReservation.findMany({ where: { correlationId: image.id } }),
      ).toMatchObject([{ status: "COMMITTED", committedMinor: 4n }]);
      const parents = await db.videoRunStep.findMany({
        where: {
          runId: run.id,
          key: { in: frame ? ["shot-0"] : ["SCRIPTING", "planning:manifest:v1"] },
        },
      });
      expect(parents).toHaveLength(frame ? 1 : 2);
      for (const parent of parents)
        expect(parent).toMatchObject({ state: "FAILED", error: { code: "PROVIDER_REFUSED" } });
      bindMedia(t, native);
      await t.engine.recover();
      await t.engine.process(work);
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow();
      if (frame) {
        await t.engine.process({ ...job, stepId: rows[2]!.id });
        expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "NEEDS_HUMAN" });
        const accepted = await db.videoRunStep.findFirstOrThrow({
          where: { runId: run.id, state: "WAITING_EXTERNAL" },
        });
        const collect = vi.spyOn(original, "fetch");
        native.image = original;
        await t.engine.process({ ...job, stepId: accepted.id });
        await t.engine.process({ ...job, stepId: accepted.id });
        expect(collect).toHaveBeenCalledOnce();
        expect(
          await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
        ).toMatchObject({ reservedMinor: 0, spentMinor: 8 });
      }
      await t.engine.process(job);
      expect(native.submitted).toHaveLength(0);
      expect(http).toHaveBeenCalledOnce();
      expect(http.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "FAILED",
        pauseReason: "PROVIDER_REFUSED",
      });
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow();
    },
  );

  it("settles the run when an in-flight sibling keyframe returns a confirmed 400", async () => {
    const t = await fixture.tenant("L2", 30, narrator);
    const run = await generating(t);
    const db = t.store.scoped(t.context);
    const shots = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const job = (index: number): RunJob => t.runs.job(t.context, run.id, shots[index]!.id);
    const native = fakeMediaPorts(run.workspaceId, t.storage, mediaBytes, []);
    const firstPosted = Promise.withResolvers<void>();
    const secondPosted = Promise.withResolvers<void>();
    const rejectSecond = Promise.withResolvers<void>();
    const http = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        firstPosted.resolve();
        await secondPosted.promise;
        return refusedImage();
      })
      .mockImplementationOnce(async () => {
        secondPosted.resolve();
        await rejectSecond.promise;
        return Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 });
      });
    native.image = imagePort(http);
    bindMedia(t, native);
    const refused = expect(t.engine.process(job(0))).rejects.toBeInstanceOf(SubmissionRefused);
    await firstPosted.promise;
    const rejected = expect(t.engine.process(job(1))).rejects.toMatchObject({
      dispatched: false,
      http: { status: 400, code: "INVALID_ARGUMENT" },
    });
    try {
      await refused;
      const sibling = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "media:keyframe:1:v1", state: "RUNNING" },
      });
      expect(
        await db.runEvent.count({ where: { stepId: sibling.id, type: "provider_dispatch" } }),
      ).toBe(1);
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "NEEDS_HUMAN",
        pauseReason: `RECONCILE_REQUIRED: provider submission outcome unknown (${sibling.id})`,
      });
    } finally {
      rejectSecond.resolve();
      await rejected;
    }

    const failure = { state: "FAILED", pauseReason: "PROVIDER_REFUSED" };
    expect(await t.store.get(t.context, run.id)).toMatchObject(failure);
    const images = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "media:keyframe:" } },
      orderBy: { key: "asc" },
    });
    expect(images).toMatchObject([{ state: "FAILED" }, { state: "CANCELLED" }]);
    expect(
      await db.runEvent.findFirst({ where: { stepId: images[1]!.id, type: "transition" } }),
    ).toMatchObject({
      payload: { from: "NEEDS_HUMAN", to: "FAILED", refundedMinor: 4 },
    });
    bindMedia(t, native);
    for (let sweep = 0; sweep < 2; sweep++) {
      await t.engine.recover();
      await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Run cannot resume");
      for (const index of [0, 1]) await t.engine.process(job(index));
    }
    expect(await t.store.get(t.context, run.id)).toMatchObject(failure);
    expect(
      await t.db.usageReservation.findMany({
        where: { workspaceId: run.workspaceId },
        orderBy: { createdAt: "asc" },
      }),
    ).toMatchObject([
      { correlationId: images[0]!.id, status: "COMMITTED", committedMinor: 4n },
      { correlationId: images[1]!.id, status: "RELEASED", committedMinor: null },
    ]);
    expect(await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 4,
    });
    expect(http.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "POST"]);
    expect(native.submitted).toHaveLength(0);
  });
});
