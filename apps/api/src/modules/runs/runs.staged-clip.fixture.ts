import { vi, type Mock } from "vitest";
import { generating, type Tenant } from "./runs.fixture.js";
import type { ProcessRunner } from "@reelforge/media";
import { ShotSpecSchema } from "@reelforge/contracts";
import { capabilityCatalog, Interactions, OmniVideo, ProviderHttp } from "@reelforge/ai-providers";
import { ProviderArtifacts } from "../openai/provider-artifacts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import type { Run, Step, RunJob } from "./runs.types.js";

export function completed(seconds?: number, clip = "clip"): Response {
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

export async function eightSecondShot(t: Tenant, runId: string, ordinal: number): Promise<Step> {
  const shot = await t.db.videoRunStep.findFirstOrThrow({
    where: { runId, key: `shot-${ordinal}` },
  });
  return t.db.videoRunStep.update({
    where: { id: shot.id },
    data: { input: { ...ShotSpecSchema.parse(shot.input), durationSeconds: 8 } },
  });
}

export async function stagedClip(
  t: Tenant,
  limit = 70,
): Promise<{
  t: Tenant;
  run: Run;
  shot: Step;
  job: RunJob;
  fetcher: Mock<typeof fetch>;
  probe: { fps: number };
  native: OmniVideo;
}> {
  const run = await generating(t);
  const shot = await eightSecondShot(t, run.id, 0);
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
