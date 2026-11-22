import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { RunsModule } from "./runs.module.js";
import { expect, vi, type Mock } from "vitest";
import { generating, type Tenant } from "./runs.fixture.js";
import type { ProcessRunner } from "@reelforge/media";
import { ShotSpecSchema } from "@reelforge/contracts";
import {
  capabilityCatalog,
  GrokVideo,
  Interactions,
  OmniVideo,
  ProviderHttp,
} from "@reelforge/ai-providers";
import { ProviderArtifacts } from "../openai/provider-artifacts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import type { Run, Step, RunJob } from "./runs.types.js";
import { shotReceiptBufferMinor } from "../usage-budget/run-envelope.js";

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

export const clipUri = "https://storage.googleapis.com/fixture/late.mp4";
const providers = {
  gemini: {
    queued: (id?: string): Response => Response.json({ status: "queued", id }),
    completed,
    jobUrl: "https://generativelanguage.googleapis.com/v1beta/interactions/accepted",
    centsPerSecond: 7,
  },
  xai: {
    queued: (id?: string): Response => Response.json({ status: "pending", request_id: id }),
    completed: (seconds: number): Response =>
      Response.json({ status: "done", video: { duration: seconds, url: clipUri } }),
    jobUrl: "https://api.x.ai/v1/videos/accepted",
    centsPerSecond: 14,
  },
};

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
  provider: keyof typeof providers = "gemini",
): Promise<{
  t: Tenant;
  run: Run;
  shot: Step;
  job: RunJob;
  fetcher: Mock<typeof fetch>;
  probe: { fps: number; exitCode: number };
  native: OmniVideo | GrokVideo;
  wire: (typeof providers)[keyof typeof providers];
}> {
  const run = await generating(t);
  const shot = await eightSecondShot(t, run.id, 0);
  await t.usage.upsertBudget(t.context, {
    currency: "USD",
    monthlyLimitMinor: limit,
    reason: "receipt test",
  });

  const wire = providers[provider];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) => {
      expect(url).toBe(clipUri);
      return new Response("clip");
    })
    .mockResolvedValueOnce(wire.queued("accepted"));
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
  const capability = capabilityCatalog(
    run.workspaceId,
    { video: "fixture", xaiVideo: "fixture", image: "", music: "", text: "", tts: "" },
    { gemini: provider === "gemini", xai: provider === "xai" },
  ).find((row) => row.providerId === provider && row.kind === "VIDEO")!;
  const refs = { resolve: async (): Promise<[]> => [] };
  const key = (provider === "gemini" ? "AIza" : "xai-") + "aB1".repeat(12);
  const http = new ProviderHttp(key, provider, fetcher);
  const native =
    provider === "gemini"
      ? new OmniVideo(new Interactions(http, staging), capability, refs)
      : new GrokVideo(http, staging, capability, refs);
  if (provider === "xai") t.generation.fallbackProvider = t.generation.provider;
  const jobs = new MediaJobs({} as MediaAccess, {} as MediaAccounts, t.storage);
  t.generation.provider = new RoutedMediaVideo(native, jobs, t.context, run);
  vi.spyOn(native, "submit");
  vi.spyOn(native, "fetch");
  const job = t.runs.job(t.context, run.id, shot.id);
  return { t, run, shot, job, fetcher, probe, native, wire };
}

const deliveryFailures = [
  { kind: "empty body", message: "empty media body", pause: "GENERATION_FAILED" },
  { kind: "nonzero probe", message: "Provider media process failed", pause: "GENERATION_FAILED" },
  { kind: "wrong fps", message: "invalid 720p video", pause: "GENERATION_FAILED" },
  { kind: "download error", message: "Provider outage", pause: "PROVIDER_OUTAGE" },
  { kind: "download denied", message: "Provider refusal (HTTP 403)", pause: "PROVIDER_REFUSED" },
  { kind: "storage error", message: "storage offline", pause: "GENERATION_FAILED" },
] as const;

export const clipFailures = [
  ...deliveryFailures.map((failure) => ({ ...failure, provider: "gemini" as const })),
  ...(["gemini", "xai"] as const).map((provider) => ({
    provider,
    kind: "job GET 503" as const,
    message: "Provider outage (HTTP 503)",
    pause: "PROVIDER_OUTAGE",
  })),
];

export const lateClipCases = [
  { provider: "gemini" as const, kind: "valid" as const, seconds: 12, pause: null },
  ...clipFailures.flatMap(({ provider, kind, pause }) =>
    [10, 12].map((seconds) => ({ provider, kind, seconds, pause })),
  ),
];

export function failingClip(
  { t, probe, fetcher }: Awaited<ReturnType<typeof stagedClip>>,
  kind: (typeof clipFailures)[number]["kind"],
  seconds: number,
): Response {
  if (kind === "job GET 503") return new Response(null, { status: 503 });
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
  { t, shot, job, fetcher, wire }: Awaited<ReturnType<typeof stagedClip>>,
  recoveredSeconds: number,
  lateSeconds: number,
  beforeDelivery: () => Promise<void | Response>,
  pollSeconds = recoveredSeconds,
): Promise<Step> {
  const started = Promise.withResolvers<void>();
  const lateFetch = Promise.withResolvers<Response>();
  fetcher
    .mockResolvedValueOnce(wire.completed(pollSeconds))
    .mockImplementationOnce(() => {
      started.resolve();
      return lateFetch.promise;
    })
    .mockResolvedValueOnce(wire.completed(recoveredSeconds));
  let response = completed(lateSeconds, "late clip");
  const original = t.engine.process(job);
  try {
    await Promise.race([
      started.promise,
      original.then(() => {
        throw new Error("Original worker finished before its fetch was gated");
      }),
    ]);
    expect(fetcher).toHaveBeenLastCalledWith(
      wire.jobUrl,
      expect.objectContaining({ method: "GET" }),
    );
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "WAITING_EXTERNAL",
      providerJobId: "accepted",
      output: { receipt: { costBasis: "BILLED", seconds: pollSeconds } },
    });
    await t.engine.process(job);
    const settled = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } });
    expect(settled.state).toBe("SUCCEEDED");
    response = (await beforeDelivery()) ?? response;
    return settled;
  } finally {
    lateFetch.resolve(response);
    expect(await original).toBeNull();
  }
}

export async function expectSettled(
  { t, shot, wire }: Awaited<ReturnType<typeof stagedClip>>,
  seconds: number,
  envelope?: {
    spentMinor: number;
    reservedMinor: number;
    overageMinor: number;
  },
  budgetConsumedMinor?: number,
): Promise<void> {
  const where = { workspaceId: shot.workspaceId, correlationId: shot.id };
  const cost = seconds * wire.centsPerSecond;
  const estimate = 8 * wire.centsPerSecond;
  const admitted = estimate + shotReceiptBufferMinor(estimate);
  const requests = await t.db.providerRequest.findMany({ where });
  expect(requests).toMatchObject([{ status: "SUCCEEDED", errorCode: null }]);
  expect(requests[0]!.actualCost?.mul(100).toString()).toBe(String(cost));
  expect(await t.db.usageReservation.findMany({ where })).toMatchObject([
    { status: "COMMITTED", committedMinor: BigInt(cost) },
  ]);
  expect(
    await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: shot.runId } }),
  ).toMatchObject(
    envelope ?? {
      spentMinor: cost,
      reservedMinor: Math.max(0, admitted - cost),
      overageMinor: Math.max(0, cost - admitted),
    },
  );
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
    state: "SUCCEEDED",
    providerJobId: "accepted",
    costMinor: cost,
    output: { receipt: { costBasis: "BILLED", seconds, costMinor: cost } },
  });
  if (budgetConsumedMinor !== undefined)
    expect((await t.usage.listBudgets(t.context))[0]!.periods[0]!.consumedMinor).toBe(
      budgetConsumedMinor,
    );
}

export async function admitSibling({
  t,
  run,
  fetcher,
  wire,
}: Awaited<ReturnType<typeof stagedClip>>): Promise<void> {
  const sibling = await eightSecondShot(t, run.id, 1);
  fetcher.mockResolvedValueOnce(wire.queued("sibling")).mockResolvedValueOnce(wire.queued());
  expect(await t.engine.process(t.runs.job(t.context, run.id, sibling.id))).toBe(12000);
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({
    state: "WAITING_EXTERNAL",
    providerJobId: "sibling",
    costMinor: 8 * wire.centsPerSecond + shotReceiptBufferMinor(8 * wire.centsPerSecond),
  });
}

export async function expectSiblingBlockedByBuffer(
  { t, run }: Awaited<ReturnType<typeof stagedClip>>,
  envelope: { spentMinor: number; reservedMinor: number; hardCapMinor: number },
): Promise<void> {
  const sibling = await eightSecondShot(t, run.id, 1);
  const estimate = t.generation.provider.estimate(ShotSpecSchema.parse(sibling.input), false);
  expect(
    envelope.spentMinor + envelope.reservedMinor + estimate + shotReceiptBufferMinor(estimate),
  ).toBeGreaterThan(envelope.hardCapMinor);
}

export function expectBillingReconciliation(
  events: readonly { type: string }[],
  expected: boolean,
): void {
  expect(events.filter((event) => event.type === "billing_reconciled")).toHaveLength(
    expected ? 1 : 0,
  );
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
