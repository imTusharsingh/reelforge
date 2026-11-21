import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "@reelforge/media";
import { ShotSpecSchema } from "@reelforge/contracts";
import { capabilityCatalog, Interactions, OmniVideo, ProviderHttp } from "@reelforge/ai-providers";
import { ProviderArtifacts } from "../openai/provider-artifacts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import { generating, runsFixture } from "./runs.fixture.js";

function completed(seconds: number): Response {
  return Response.json({
    status: "completed",
    usage: { billed_seconds: seconds },
    steps: [
      {
        type: "model_output",
        content: [
          { type: "video", mime_type: "video/mp4", data: Buffer.from("clip").toString("base64") },
        ],
      },
    ],
  });
}

describe.skipIf(!process.env.DATABASE_URL)("Gemini shot receipts and staged clips", () => {
  const fixture = runsFixture();

  it.each(["fetch storage failure", "missing stage", "corrupt stage"])(
    "retains the higher fetch charge and collects the accepted job after %s",
    async (cut) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const shot = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      await t.db.videoRunStep.update({
        where: { id: shot.id },
        data: { input: { ...ShotSpecSchema.parse(shot.input), durationSeconds: 8 } },
      });
      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        monthlyLimitMinor: 70,
        reason: "receipt test",
      });

      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ status: "queued", id: "accepted" }))
        .mockResolvedValueOnce(completed(8)) // poll
        .mockResolvedValueOnce(completed(10)) // fetch
        .mockResolvedValueOnce(completed(8)); // refetch of the same job
      const staging = new ProviderArtifacts(t.storage, run.workspaceId, {
        run: async (): ReturnType<ProcessRunner["run"]> => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", width: 720, height: 1280, r_frame_rate: "24/1" }],
            format: { duration: "7" },
          }),
        }),
      });
      const native = new OmniVideo(
        new Interactions(new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher), staging),
        capabilityCatalog(
          run.workspaceId,
          { video: "fixture", xaiVideo: "", image: "", music: "", text: "", tts: "" },
          { gemini: true, xai: false },
        )[0]!,
        { resolve: async (): Promise<[]> => [] },
      );
      const jobs = new MediaJobs({} as MediaAccess, {} as MediaAccounts, t.storage);
      t.generation.provider = new RoutedMediaVideo(native, jobs, t.context, run);
      const submit = vi.spyOn(native, "submit");
      const fetchJob = vi.spyOn(native, "fetch");
      if (cut === "fetch storage failure")
        vi.spyOn(t.storage, "putObject").mockRejectedValueOnce(new Error("storage offline"));
      else vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
      const job = t.runs.job(t.context, run.id, shot.id);
      await expect(t.engine.process(job)).rejects.toThrow("storage offline");

      const checksumSha256 = createHash("sha256").update("clip").digest("hex");
      const staged = { workspaceId: run.workspaceId, objectKey: `providers/${checksumSha256}` };
      const where = { workspaceId: run.workspaceId, correlationId: shot.id };
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "WAITING_EXTERNAL",
        providerJobId: "accepted",
        output: {
          receipt: { costMinor: 70, seconds: 10 },
          pendingMedia: cut === "fetch storage failure" ? null : { objectKey: staged.objectKey },
        },
      });
      expect((await t.db.providerRequest.findFirstOrThrow({ where })).actualCost?.toNumber()).toBe(
        0.7,
      );
      expect((await t.db.usageReservation.findFirstOrThrow({ where })).amountMinor).toBe(70n);
      await expect(
        t.usage.reserve(run.workspaceId, {
          currency: "USD",
          category: "VIDEO_MEDIA",
          amountMinor: 14,
          idempotencyKey: "competing",
        }),
      ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      if (cut === "missing stage") await t.storage.deleteObject(staged);
      if (cut === "corrupt stage")
        await t.storage.putObject({
          ...staged,
          contentType: "video/mp4",
          body: Buffer.from("corrupt"),
        });

      await t.engine.process(job);
      await t.engine.process(job);
      expect(submit).toHaveBeenCalledOnce();
      expect(fetchJob.mock.calls.map(([id]) => id)).toEqual(["accepted", "accepted"]);
      expect(await t.storage.getObject(staged)).toEqual(Buffer.from("clip"));
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
        state: "SUCCEEDED",
        output: {
          storageArtifacts: [{ checksumSha256 }],
          receipt: { costMinor: 70, seconds: 10, providerDurationSeconds: 7 },
        },
      });
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({
        reservedMinor: 0,
        spentMinor: 70,
        overageMinor: 14,
      });
      expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
        { status: "COMMITTED", committedMinor: 70n },
      ]);
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: shot.id, type: "billing_reconciled" },
        }),
      ).toBe(1);
    },
  );
});
