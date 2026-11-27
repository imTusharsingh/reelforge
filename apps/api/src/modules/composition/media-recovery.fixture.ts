import { createHash } from "node:crypto";
import type {
  ClipArtifact,
  MediaJobPort,
  VideoGenPort,
  TextPort,
  VideoOptions,
} from "@reelforge/ai-providers";
import { capabilityCatalog, secondsCost } from "@reelforge/ai-providers";
import { MediaReceiptSchema, ShotSpecSchema, type ShotSpec } from "@reelforge/contracts";
import type { Tenant } from "../runs/runs.fixture.js";
import { json } from "../runs/runs.types.js";
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

export async function seedPlayableShotReceipts(
  t: Tenant,
  leaveFirstShotPending: boolean,
): Promise<ShotSpec[]> {
  const db = t.store.scoped(t.context);
  const records = await db.shotSpec.findMany({
    where: { runId: t.run.id },
    orderBy: { ordinal: "asc" },
  });
  const shots = records.map((row) => ShotSpecSchema.parse(row.document));
  // Audio recovery starts after generation. Seed playable receipts without opening paid jobs.
  for (const shot of leaveFirstShotPending ? shots.slice(1) : shots) {
    const key = `shot-${shot.ordinal}`;
    const artifact = await t.artifacts.put(t.context, "clips", Buffer.from(key), "video/mp4");
    const receipt = MediaReceiptSchema.parse({
      key,
      providerId: "gemini",
      providerJobId: `fixture-clip-${shot.ordinal}`,
      modelId: "fixture-video",
      promptVersion: "fixture:v1",
      seconds: shot.durationSeconds,
      costMinor: 0,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "video/mp4",
    });
    const changed = await db.videoRunStep.updateMany({
      where: { runId: t.run.id, key, state: "PENDING" },
      data: { state: "SUCCEEDED", output: json({ receipt, storageArtifacts: [artifact] }) },
    });
    if (changed.count !== 1) throw new Error(`Expected one pending fixture step for ${key}`);
  }
  return shots;
}
