import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interactions, NanoBanana, ProviderHttp, SubmissionRefused } from "@reelforge/ai-providers";
import { generating, runsFixture } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-fixture.fixture.js";

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
      const t = await fixture.tenant(
        "L2",
        30,
        {
          providerId: "gemini",
          voiceId: "narrator",
          language: "English",
          pace: 1,
        },
        frame,
      );
      const run = frame ? await generating(t) : t.run;
      const db = t.store.scoped(t.context);
      const job = t.runs.job(t.context, run.id);
      const shots = shotsFixture({ ...planningFixture(), runId: run.id, brief: t.brief }).map(
        (shot) => ({ ...shot, workspaceId: run.workspaceId, durationSeconds: 5 }),
      );
      const native = fakeMediaPorts(
        run.workspaceId,
        t.storage,
        {
          audio: Buffer.from("audio"),
          image: Buffer.from("image"),
          clip: Buffer.from("clip"),
        },
        [
          scriptFixture(),
          shots,
          { character: null, styleFrame: "Leaves", keyframePrompts: shots.map(() => "Leaf") },
        ],
      );
      bindMedia(t, native);
      const rows = await db.videoRunStep.findMany({
        where: { runId: run.id, key: { startsWith: "shot-" } },
        orderBy: { key: "asc" },
      });
      const original = native.image;
      if (frame) {
        vi.spyOn(original, "poll").mockResolvedValueOnce("running");
        expect(await t.engine.process({ ...job, stepId: rows[1]!.id })).toBe(12000);
      } else await t.engine.process(job);
      const http = vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json({
          status: "failed",
          id: "refused-image",
          error: { code: "safety" },
        }),
      );
      native.image = new NanoBanana(
        new Interactions(new ProviderHttp("AIza" + "abc".repeat(12), "gemini", http), {
          save: async (): Promise<never> => {
            throw new Error("Unexpected download");
          },
        }),
        "image",
      );
      const work = frame ? { ...job, stepId: rows[0]!.id } : job;
      await expect(t.engine.process(work)).rejects.toBeInstanceOf(SubmissionRefused);
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
});
