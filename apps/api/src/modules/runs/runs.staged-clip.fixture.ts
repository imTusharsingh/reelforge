import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { RunsModule } from "./runs.module.js";
import { expect, vi, type Mock } from "vitest";
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

export function completed(seconds?: number, clip: string | { uri: string } = "clip"): Response {
  return Response.json({
    status: "completed",
    ...(seconds !== undefined && { usage: { billed_seconds: seconds } }),
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "video",
            mime_type: "video/mp4",
            ...(typeof clip === "string" ? { data: Buffer.from(clip).toString("base64") } : clip),
          },
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
  probe: { fps: number; exitCode: number };
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
  const probe = { fps: 24, exitCode: 0 };
  const staging = new ProviderArtifacts(t.storage, run.workspaceId, {
    run: async (): ReturnType<ProcessRunner["run"]> => ({
      exitCode: probe.exitCode,
      stderr: probe.exitCode ? "moov atom not found" : "",
      stdout: probe.exitCode
        ? ""
        : JSON.stringify({
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

export const clipUri = "https://storage.googleapis.com/fixture/late.mp4";
export const clipFailures = [
  { kind: "empty body", message: "empty media body", pause: "GENERATION_FAILED" },
  { kind: "nonzero probe", message: "Provider media process failed", pause: "GENERATION_FAILED" },
  { kind: "wrong fps", message: "invalid 720p video", pause: "GENERATION_FAILED" },
  { kind: "download error", message: "Provider outage", pause: "PROVIDER_OUTAGE" },
  { kind: "download denied", message: "Provider refusal (HTTP 403)", pause: "PROVIDER_REFUSED" },
  { kind: "storage error", message: "storage offline", pause: "GENERATION_FAILED" },
] as const;

export const lateClipCases = [
  { kind: "valid" as const, seconds: 12, pause: null },
  ...clipFailures.flatMap(({ kind, pause }) =>
    [10, 12].map((seconds) => ({ kind, seconds, pause })),
  ),
];

export function failingClip(
  { t, probe, fetcher }: Awaited<ReturnType<typeof stagedClip>>,
  kind: (typeof clipFailures)[number]["kind"],
  seconds: number,
): Response {
  fetcher.mockImplementationOnce(async () => {
    if (kind === "download error") throw new TypeError("connection reset");
    if (kind === "download denied") return new Response(null, { status: 403 });
    return new Response(kind === "empty body" ? null : "late clip");
  });
  if (kind === "nonzero probe") probe.exitCode = 1;
  if (kind === "wrong fps") probe.fps = 30;
  if (kind === "storage error")
    vi.spyOn(t.storage, "putObject").mockRejectedValueOnce(new Error("storage offline"));
  return completed(seconds, { uri: clipUri });
}

export async function recoverBeforeLateFetch(
  { t, shot, job, fetcher }: Awaited<ReturnType<typeof stagedClip>>,
  recoveredSeconds: number,
  lateSeconds: number,
  beforeDelivery: () => Promise<void | Response>,
): Promise<Step> {
  const started = Promise.withResolvers<void>();
  const lateFetch = Promise.withResolvers<Response>();
  fetcher
    .mockResolvedValueOnce(completed(recoveredSeconds))
    .mockImplementationOnce(() => {
      started.resolve();
      return lateFetch.promise;
    })
    .mockResolvedValueOnce(completed(recoveredSeconds));
  let response = completed(lateSeconds, "late clip");
  const original = t.engine.process(job);
  try {
    await Promise.race([
      started.promise,
      original.then(() => {
        throw new Error("Original worker finished before its fetch was gated");
      }),
    ]);
    await t.engine.process(job);
    const settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(settled.state).toBe("SUCCEEDED");
    response = (await beforeDelivery()) ?? response;
    return settled;
  } finally {
    // Native fetch records the price first, then the collector delivers the priced descriptor.
    lateFetch.resolve(response);
    await expect(original).resolves.toBeNull();
  }
}

export async function postEditorApproval(t: Tenant): Promise<request.Response> {
  const { userId, workspaceId } = t.context;
  await t.db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { role: "EDITOR" },
  });
  const token = randomUUID();
  await t.db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) },
  });
  const module = await Test.createTestingModule({ imports: [RunsModule] })
    .overrideProvider("DATABASE")
    .useValue(t.db)
    .compile();
  const app = module.createNestApplication();
  try {
    app.setGlobalPrefix("api/v1");
    await app.init();
    return await request(app.getHttpServer())
      .post(`/api/v1/runs/${t.run.id}/approve`)
      .query({ workspaceId })
      .set("Authorization", `Bearer ${token}`);
  } finally {
    await app.close();
  }
}
