import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ClipArtifact,
  MediaJobPort,
  VideoGenPort,
  TextPort,
  VideoOptions,
} from "@reelforge/ai-providers";
import { capabilityCatalog, secondsCost } from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { SpawnProcessRunner } from "./composition.engine.js";
export async function fixtureMedia(): Promise<{ clip: Buffer; image: Buffer; audio: Buffer }> {
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
      "testsrc2=size=720x1280:rate=24:duration=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=5",
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
export function fakeMediaPorts(
  workspaceId: string,
  storage: StoragePort,
  bytes: { clip: Buffer; image: Buffer; audio: Buffer },
  outputs: unknown[],
): {
  omni: VideoGenPort;
  grok: VideoGenPort;
  image: MediaJobPort<{ prompt: string }>;
  tts: MediaJobPort<{ text: string; voice: string }>;
  music: MediaJobPort<{ prompt: string }>;
  text: TextPort;
  submitted: { spec: ShotSpec; options: VideoOptions }[];
} {
  const submitted: { spec: ShotSpec; options: VideoOptions }[] = [];
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
  const video = (providerId: string): VideoGenPort => ({
    capabilities: () =>
      catalog.find((cap) => cap.providerId === providerId && cap.kind === "VIDEO")!,
    estimate: (spec) =>
      secondsCost(
        spec.durationSeconds,
        catalog.find((cap) => cap.providerId === providerId && cap.kind === "VIDEO")!
          .pricePerSecond["720p"]!,
      ),
    submit: async (spec, _key, options = {}): Promise<{ providerJobId: string }> => {
      submitted.push({ spec, options });
      return { providerJobId: `fixture-video-${++id}` };
    },
    poll: async () => "succeeded",
    fetch: async () => save(bytes.clip, "video/mp4", 5),
  });
  return {
    omni: video("gemini"),
    grok: video("xai"),
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
