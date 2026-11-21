import { createHash } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ProcessRunner } from "@reelforge/media";
import { ShotSpecSchema } from "@reelforge/contracts";
import { capabilityCatalog, Interactions, OmniVideo, ProviderHttp } from "@reelforge/ai-providers";
import { ProviderArtifacts } from "../openai/provider-artifacts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import type { Run, Step, RunJob } from "./runs.types.js";
import { generating, runsFixture, type Tenant } from "./runs.fixture.js";

function completed(seconds?: number, clip = "clip"): Response {
  return Response.json({
    status: "completed",
    ...(seconds !== undefined && { usage: { billed_seconds: seconds } }),
    steps: [
      {
        type: "model_output",
        content: [
          { type: "video", mime_type: "video/mp4", data: Buffer.from(clip).toString("base64") },
        ],
      },
    ],
  });
}

describe.skipIf(!process.env.DATABASE_URL)("Gemini shot receipts and staged clips", () => {
  const fixture = runsFixture();

  async function setup(limit = 70): Promise<{
    t: Tenant;
    run: Run;
    shot: Step;
    job: RunJob;
    fetcher: Mock<typeof fetch>;
    probe: { fps: number };
    native: OmniVideo;
  }> {
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
      monthlyLimitMinor: limit,
      reason: "receipt test",
    });

    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "queued", id: "accepted" }));
    const probe = { fps: 24 };
    const staging = new ProviderArtifacts(t.storage, run.workspaceId, {
      run: async (): ReturnType<ProcessRunner["run"]> => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          streams: [
            { codec_type: "video", width: 720, height: 1280, r_frame_rate: `${probe.fps}/1` },
          ],
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
    vi.spyOn(native, "submit");
    vi.spyOn(native, "fetch");
    const job = t.runs.job(t.context, run.id, shot.id);
    return { t, run, shot, job, fetcher, probe, native };
  }

  it.each(["fetch storage failure", "missing stage", "corrupt stage"])(
    "retains the higher fetch charge and collects the accepted job after %s",
    async (cut) => {
      const { t, run, shot, job, fetcher, native } = await setup();
      fetcher
        .mockResolvedValueOnce(completed(8)) // poll
        .mockResolvedValueOnce(completed(10)) // fetch
        .mockResolvedValueOnce(completed(8)); // refetch of the same job
      if (cut === "fetch storage failure")
        vi.spyOn(t.storage, "putObject").mockRejectedValueOnce(new Error("storage offline"));
      else vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
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
      expect(native.submit).toHaveBeenCalledOnce();
      expect(vi.mocked(native.fetch).mock.calls.map(([id]) => id)).toEqual([
        "accepted",
        "accepted",
      ]);
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

  async function expectSettled(t: Tenant, shot: Step, seconds: number): Promise<void> {
    const where = { workspaceId: shot.workspaceId, correlationId: shot.id };
    const cost = seconds * 7;
    const requests = await t.db.providerRequest.findMany({ where });
    expect(requests).toMatchObject([{ status: "SUCCEEDED", errorCode: null }]);
    expect(requests[0]!.actualCost?.mul(100).toString()).toBe(String(cost));
    expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
      { status: "COMMITTED", committedMinor: BigInt(cost) },
    ]);
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: shot.runId } }),
    ).toMatchObject({
      spentMinor: cost,
      reservedMinor: 0,
      overageMinor: Math.max(0, cost - 56),
    });
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "SUCCEEDED",
      providerJobId: "accepted",
      costMinor: cost,
      output: { receipt: { costBasis: "BILLED", seconds, costMinor: cost } },
    });
  }

  it("charges the 14-cent difference once when the original fetch returns after recovery settles", async () => {
    const { t, run, shot, job, fetcher, native } = await setup(84);
    const started = Promise.withResolvers<void>();
    const lateFetch = Promise.withResolvers<Response>();
    fetcher
      .mockResolvedValueOnce(completed(10))
      .mockImplementationOnce(() => {
        started.resolve();
        return lateFetch.promise;
      })
      .mockResolvedValueOnce(completed(10));
    const put = vi.spyOn(t.artifacts, "put");
    const original = t.engine.process(job);
    let settled: Step;
    try {
      await Promise.race([started.promise, original]);
      await t.engine.process(job);
      await expectSettled(t, shot, 10);
      settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    } finally {
      // The native fetch reports 84 cents before staging and again with its clip descriptor.
      lateFetch.resolve(completed(12, "late clip"));
      await original;
    }
    await t.engine.process(job);
    await expectSettled(t, shot, 12);
    const corrected = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(corrected.finishedAt).toEqual(settled.finishedAt);
    expect(t.artifacts.descriptors(corrected.output)).toEqual(
      t.artifacts.descriptors(settled.output),
    );
    const events = await t.db.runEvent.findMany({ where: { runId: run.id, stepId: shot.id } });
    expect(events.filter((e) => e.type === "billing_reconciled")).toHaveLength(1);
    expect(
      events.filter(
        (e) =>
          e.type === "provider_receipt" &&
          e.payload &&
          typeof e.payload === "object" &&
          "adjustmentMinor" in e.payload,
      ),
    ).toMatchObject([{ payload: { adjustmentMinor: 14, costMinor: 84 } }]);
    expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(84);
    await expect(
      t.usage.reserve(run.workspaceId, {
        currency: "USD",
        category: "VIDEO_MEDIA",
        amountMinor: 14,
        idempotencyKey: "competing",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(put).toHaveBeenCalledOnce();
    expect(native.submit).toHaveBeenCalledOnce();
  });

  it.each(["poll", "staging repair"])(
    "uses the six billed seconds from %s for an eight-second request",
    async (source) => {
      const { t, shot, job, fetcher, native } = await setup();
      fetcher
        .mockResolvedValueOnce(completed(source === "poll" ? 6 : undefined))
        .mockResolvedValueOnce(completed());
      if (source === "staging repair") {
        vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
        await expect(t.engine.process(job)).rejects.toThrow("storage offline");
        const staged = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
        expect(staged.output).toMatchObject({
          receipt: { costBasis: "RESERVATION", costMinor: 56 },
        });
        await t.storage.deleteObject({
          workspaceId: shot.workspaceId,
          objectKey: `providers/${createHash("sha256").update("clip").digest("hex")}`,
        });
        fetcher.mockResolvedValueOnce(completed(6));
      }
      await t.engine.process(job);
      await t.engine.process(job);
      await expectSettled(t, shot, 6);
      expect(native.submit).toHaveBeenCalledOnce();
    },
  );

  it("keeps the valid descriptor and higher liability across an invalid replacement", async () => {
    const { t, shot, job, fetcher, probe, native } = await setup(84);
    fetcher
      .mockResolvedValueOnce(completed(8))
      .mockResolvedValueOnce(completed(10))
      .mockResolvedValueOnce(completed(12, "30fps"))
      .mockResolvedValueOnce(completed(8, "24fps"));
    const put = vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
    await expect(t.engine.process(job)).rejects.toThrow("storage offline");
    const objectKey = `providers/${createHash("sha256").update("clip").digest("hex")}`;
    await t.storage.deleteObject({ workspaceId: shot.workspaceId, objectKey });
    probe.fps = 30;
    await expect(t.engine.process(job)).rejects.toThrow("invalid 720p video");
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      output: {
        pendingMedia: { objectKey, fps: 24 },
        receipt: { costMinor: 84, seconds: 12 },
      },
    });
    expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(84);
    expect(put).toHaveBeenCalledTimes(1);
    probe.fps = 24;
    await t.engine.process(job);
    await t.engine.process(job);
    await expectSettled(t, shot, 12);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![2]).toEqual(Buffer.from("24fps"));
    expect(vi.mocked(native.fetch).mock.calls.map(([id]) => id)).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    expect(native.submit).toHaveBeenCalledOnce();
    expect(
      await t.db.runEvent.count({ where: { stepId: shot.id, type: "billing_reconciled" } }),
    ).toBe(1);
  });
});
