import { Prisma } from "@reelforge/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("budget-paused keyframe recovery", () => {
  const fixture = runsFixture();

  beforeEach(() => {
    vi.stubEnv("GEMINI_IMAGE_MODEL", "fixture-image");
    vi.stubEnv("GEMINI_VIDEO_MODEL", "fixture-video");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["marked", "legacy", "dispatch evidence"] as const)(
    "resumes a real shot worker with a %s cancelled attempt without duplicate submissions",
    async (kind) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const db = t.store.scoped(t.context);
      const shot = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      const key = "media:keyframe:0:v1";
      const job = t.runs.job(t.context, run.id, shot.id);
      const native = fakeMediaPorts(
        run.workspaceId,
        t.storage,
        { image: Buffer.from("image"), clip: Buffer.from("clip"), audio: Buffer.from("audio") },
        [],
      );
      const imageSubmit = vi.spyOn(native.image, "submit");
      const imageFetch = vi.spyOn(native.image, "fetch");
      // Keyframe recovery must drive into real video submission without rendering a fake clip.
      vi.spyOn(native.omni, "poll").mockResolvedValue("running");
      bindMedia(t, native);
      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        dailyLimitMinor: 3,
        reason: "fixture below keyframe reservation",
      });
      await expect(t.engine.process(job)).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "PAUSED_BUDGET",
        pauseReason: "BUDGET_EXHAUSTED",
      });
      const denied = await db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key } });
      expect(denied).toMatchObject({
        state: "CANCELLED",
        providerJobId: null,
        output: { closedBy: "BUDGET_DENIED_NOT_DISPATCHED" },
      });
      expect(
        await db.runEvent.findFirst({
          where: { runId: run.id, stepId: denied.id, type: "dispatch_released" },
        }),
      ).toMatchObject({ payload: { reason: "NOT_DISPATCHED" } });
      expect(await t.db.providerRequest.count({ where: { workspaceId: run.workspaceId } })).toBe(0);

      if (kind !== "marked") {
        // Older rollback committed the same event and cancellation, but did not set output.
        await db.videoRunStep.updateMany({
          where: { runId: run.id, id: denied.id },
          data: { output: Prisma.DbNull },
        });
      }
      if (kind === "dispatch evidence") {
        await t.store.mutate(t.context, run.id, "provider_dispatch", async () => ({
          value: null,
          payload: { idempotencyKey: denied.idempotencyKey },
          stepId: denied.id,
        }));
      }

      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        dailyLimitMinor: 500,
        reason: "fixture budget refill",
      });
      await t.engine.recover();
      await t.engine.process(job);
      expect(imageSubmit).not.toHaveBeenCalled();
      expect(native.submitted).toHaveLength(0);
      expect(await db.videoRunStep.count({ where: { runId: run.id, key } })).toBe(1);

      await t.control.resume(t.context, run.id);
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "GENERATING",
        pauseReason: null,
      });
      if (kind === "dispatch evidence") {
        await expect(t.engine.process(job)).rejects.toThrow(
          "MEDIA_NOT_DISPATCHED: new attempt required",
        );
        expect(await db.videoRunStep.count({ where: { runId: run.id, key } })).toBe(1);
        expect(imageSubmit).not.toHaveBeenCalled();
        expect(native.submitted).toHaveLength(0);
        return;
      }

      expect(await t.engine.process(job)).toBe(12000);
      expect(await t.engine.process(job)).toBe(12000);
      const frames = await db.videoRunStep.findMany({
        where: { runId: run.id, key },
        orderBy: { attempt: "asc" },
      });
      expect(frames).toMatchObject([
        { id: denied.id, state: "CANCELLED", output: { closedBy: "NOT_DISPATCHED" } },
        { attempt: 2, state: "SUCCEEDED", providerJobId: "fixture-media-1" },
      ]);
      expect(frames[1]!.idempotencyKey).not.toBe(denied.idempotencyKey);
      expect(imageSubmit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ prompt: expect.any(String) }),
        frames[1]!.idempotencyKey,
      );
      expect(imageFetch).toHaveBeenCalledOnce();
      expect(native.submitted).toHaveLength(1);
      expect(
        await db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, id: shot.id } }),
      ).toMatchObject({ state: "WAITING_EXTERNAL", providerJobId: "fixture-video-2" });
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: run.workspaceId } }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ correlationId: frames[1]!.id, status: "COMMITTED" }),
          expect.objectContaining({ correlationId: shot.id, status: "RESERVED" }),
        ]),
      );
    },
  );
});
