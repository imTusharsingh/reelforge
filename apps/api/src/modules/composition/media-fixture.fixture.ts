import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import type { Tenant } from "../runs/runs.fixture.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ClipArtifact,
  MediaJobPort,
  VideoGenPort,
  TextPort,
  ReferenceResolver,
} from "@reelforge/ai-providers";
import {
  capabilityCatalog,
  OmniVideo,
  GrokVideo,
  Interactions,
  ProviderHttp,
} from "@reelforge/ai-providers";
import { ProviderArtifacts } from "../openai/provider-artifacts.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { SpawnProcessRunner } from "./composition.engine.js";
async function fixtureMedia(
  seconds: number,
): Promise<{ clip: Buffer; image: Buffer; audio: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "reelforge-v5-fixture-"));
  const runner = new SpawnProcessRunner();
  const call = async (argv: string[]): Promise<void> => {
    const result = await runner.run({
      executable: "ffmpeg",
      argv: ["-v", "error", "-nostdin", "-y", ...argv],
    });
    if (result.exitCode) throw new Error(result.stderr);
  };
  try {
    await call([
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=720x1280:rate=24:duration=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(root, "clip.mp4"),
    ]);
    await call([
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:size=720x1280",
      "-frames:v",
      "1",
      "-update",
      "1",
      join(root, "image.png"),
    ]);
    await call([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=30",
      "-c:a",
      "pcm_s16le",
      join(root, "audio.wav"),
    ]);
    return {
      clip: await readFile(join(root, "clip.mp4")),
      image: await readFile(join(root, "image.png")),
      audio: await readFile(join(root, "audio.wav")),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function fakeMediaPorts(
  workspaceId: string,
  storage: StoragePort,
  bytes: { clip: Buffer; image: Buffer; audio: Buffer },
  outputs: unknown[],
  seconds: number,
): {
  video: (refs: ReferenceResolver) => { omni: VideoGenPort; grok: VideoGenPort };
  image: MediaJobPort<{ prompt: string }>;
  tts: MediaJobPort<{ text: string; voice: string }>;
  music: MediaJobPort<{ prompt: string }>;
  text: TextPort;
  submitted: { key: string | null; body: unknown }[];
} {
  const submitted: { key: string | null; body: unknown }[] = [];
  const catalog = capabilityCatalog(
    workspaceId,
    {
      video: "fixture-omni",
      xaiVideo: "fixture-grok",
      image: "fixture-image",
      text: "fixture-text",
      tts: "fixture-tts",
      music: "fixture-music",
    },
    { gemini: true, xai: true },
  );
  const save = async (body: Buffer, mimeType: string, seconds: number): Promise<ClipArtifact> => {
    const checksumSha256 = createHash("sha256").update(body).digest("hex"),
      objectKey = `fixture/${checksumSha256}`;
    await storage.putObject({ workspaceId, objectKey, body, contentType: mimeType });
    return {
      objectKey,
      checksumSha256,
      byteSize: body.length,
      mimeType,
      durationSeconds: seconds,
      width: mimeType.startsWith("audio") ? 0 : 720,
      height: mimeType.startsWith("audio") ? 0 : 1280,
      fps: mimeType === "video/mp4" ? 24 : 0,
      billedSeconds: seconds,
    };
  };
  let id = 0,
    text = 0;
  const media = <T>(body: Buffer, mime: string, duration: number): MediaJobPort<T> => ({
    submit: async () => ({ providerJobId: `fixture-media-${++id}` }),
    poll: async () => "succeeded",
    fetch: async () => save(body, mime, duration),
  });
  const artifacts = new ProviderArtifacts(storage, workspaceId);
  const uri = "https://storage.googleapis.com/fixture/clip.mp4";
  const http = (vendor: "gemini" | "xai"): ProviderHttp =>
    new ProviderHttp(
      (vendor === "gemini" ? "AIza" : "xai-") + "aB1".repeat(12),
      vendor,
      async (url, init) => {
        if (init?.method === "POST") {
          submitted.push({
            key: new Headers(init.headers).get("Idempotency-Key"),
            body: JSON.parse(String(init.body)) as unknown,
          });
          const job = `fixture-video-${++id}`;
          return Response.json(
            vendor === "gemini" ? { id: job, status: "queued" } : { request_id: job },
          );
        }
        if (url === uri) return new Response(new Uint8Array(bytes.clip));
        return Response.json(
          vendor === "gemini"
            ? {
                status: "completed",
                usage: { billed_seconds: seconds },
                steps: [
                  {
                    type: "model_output",
                    content: [{ type: "video", mime_type: "video/mp4", uri }],
                  },
                ],
              }
            : { status: "done", video: { duration: seconds, url: uri } },
        );
      },
    );
  const capability = (vendor: string): ReturnType<VideoGenPort["capabilities"]> =>
    catalog.find((cap) => cap.providerId === vendor && cap.kind === "VIDEO")!;
  return {
    video: (refs) => ({
      omni: new OmniVideo(new Interactions(http("gemini"), artifacts), capability("gemini"), refs),
      grok: new GrokVideo(http("xai"), artifacts, capability("xai"), refs),
    }),
    image: media(bytes.image, "image/png", 0),
    tts: media(bytes.audio, "audio/wav", 30),
    music: media(bytes.audio, "audio/wav", 30),
    text: {
      complete: async <T>(
        spec: Parameters<TextPort["complete"]>[0],
      ): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> => ({
        output: spec.parse(outputs[text++]) as T,
        providerJobId: `fixture-text-${text}`,
        usage: {},
      }),
    },
    submitted,
  };
}

export async function pipelineProviders(
  t: Tenant,
  shotCount: number,
): Promise<ReturnType<typeof fakeMediaPorts>> {
  const scriptShots = shotsFixture({ ...planningFixture(), runId: t.run.id, brief: t.brief });
  const seconds = 30 / shotCount;
  const shots = scriptShots.slice(0, shotCount).map((shot, ordinal) => ({
    ...shot,
    workspaceId: t.context.workspaceId,
    runId: t.run.id,
    durationSeconds: seconds,
    voLine:
      shotCount === 3
        ? scriptShots
            .slice(ordinal * 2, ordinal * 2 + 2)
            .map((s) => s.voLine)
            .join(" ")
        : shot.voLine,
    transition: ordinal === 0 ? "crossfade" : "cut",
  }));
  const bytes = await fixtureMedia(seconds);
  return fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    bytes,
    [
      scriptFixture(),
      shots,
      {
        character: null,
        styleFrame: "Original blue leaf illustration",
        keyframePrompts: shots.map(() => "Blue leaf, portrait 9:16"),
      },
      { hook: 9, coherence: 9, artifacts: 9, captionSync: 9, briefFit: 9, policy: 10 },
    ],
    seconds,
  );
}
