import { createHash } from "node:crypto";
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
