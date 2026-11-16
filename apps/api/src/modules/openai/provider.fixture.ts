import type { ShotSpec } from "@reelforge/contracts";
import { capabilityCatalog, type ClipArtifact } from "@reelforge/ai-providers";
const workspaceId = "00000000-0000-4000-8000-000000000001";
export const shot: ShotSpec = {
  id: workspaceId,
  workspaceId,
  schemaVersion: "1.0",
  runId: workspaceId,
  ordinal: 0,
  version: 1,
  keyframePrompt: "pond",
  motionPrompt: "boat floating",
  onScreenText: "",
  continuityNotes: [],
  firstFrameFrom: null,
  negativePrompt: "",
  durationSeconds: 8,
  voLine: "",
  dialogue: "",
  camera: "static",
  transition: "cut",
  references: [],
  width: 720,
  height: 1280,
  fps: 24,
  seed: null,
};
const models = {
  video: "video-config",
  image: "image-config",
  text: "text-config",
  tts: "tts-config",
  music: "music-config",
  xaiVideo: "xai-config",
};
export const catalog = capabilityCatalog(workspaceId, models, { gemini: true, xai: true });
export const artifact: ClipArtifact = {
  objectKey: "providers/hash",
  checksumSha256: "hash",
  byteSize: 3,
  mimeType: "video/mp4",
  durationSeconds: 8,
  width: 720,
  height: 1280,
  fps: 24,
  billedSeconds: 8,
};
