import type { VideoReceipt } from "../orchestration/video-run.handlers.js";

export function pricedClip(seconds = 10): VideoReceipt {
  return {
    costBasis: "BILLED",
    costMinor: seconds * 7,
    seconds,
    providerDurationSeconds: seconds,
    modelId: "fixture-video",
    promptVersion: "fixture",
    media: {
      objectKey: "provider-clip",
      checksumSha256: "a".repeat(64),
      byteSize: 16,
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      fps: 24,
      billedSeconds: seconds,
      durationSeconds: seconds,
    },
  };
}
