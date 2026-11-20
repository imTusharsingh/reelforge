import { createHash } from "node:crypto";
import type { ProviderCapability } from "@reelforge/contracts";
import type { ProviderModels } from "./config.js";
export function capabilityCatalog(
  workspaceId: string,
  models: ProviderModels,
  configured: Readonly<{ gemini: boolean; xai: boolean }>,
): ProviderCapability[] {
  const rows: ProviderCapability[] = [];
  for (const kind of ["VIDEO", "IMAGE", "TEXT", "TTS", "MUSIC"] as const) {
    rows.push(
      capability(
        workspaceId,
        "gemini",
        models[kind.toLowerCase() as Exclude<keyof ProviderModels, "xaiVideo">],
        kind,
        configured.gemini,
      ),
    );
  }
  rows.push(capability(workspaceId, "xai", models.xaiVideo, "VIDEO", configured.xai));
  return rows;
}
function capability(
  workspaceId: string,
  providerId: string,
  modelId: string,
  kind: ProviderCapability["kind"],
  enabled: boolean,
): ProviderCapability {
  const video = kind === "VIDEO";
  const gemini = providerId === "gemini";
  return {
    id: capabilityId(workspaceId, providerId, kind),
    workspaceId,
    schemaVersion: "1.0",
    providerId,
    modelId,
    kind,
    aspects: video || kind === "IMAGE" ? ["9:16", "16:9"] : [],
    maxReferenceImages: video ? (gemini ? 6 : 14) : kind === "IMAGE" ? 6 : 0,
    firstLastFrame: video,
    minExtensionSeconds: video && gemini ? 3 : 0,
    maxExtensionPerTurnSeconds: video && gemini ? 10 : 0,
    maxExtensionSeconds: video && gemini ? 30 : 0,
    nativeAudio: video,
    health: enabled ? "HEALTHY" : "NOT_CONFIGURED",
    enabled,
    pricePerSecond: video
      ? {
          // Gemini 360p and 1080p are provider-stated token-billing equivalents (V2 spec, Video vendor research).
          "360p": gemini ? 23000 : null,
          "720p": gemini ? 69504 : 140000,
          "1080p": gemini ? 104000 : 250000,
        }
      : { "360p": null, "720p": null, "1080p": null },
    supportsReferenceImages: video || kind === "IMAGE",
    supportsAudio: video || kind === "TEXT" || kind === "TTS" || kind === "MUSIC",
    asynchronous: true,
    polling: true,
    minDurationSeconds: video ? (gemini ? 3 : 1) : 0,
    maxDurationSeconds: video ? 15 : 0,
    resolutions: video
      ? [
          { width: 720, height: 1280 },
          { width: 1080, height: 1920 },
        ]
      : [],
    frameRates: video ? [24] : [],
    regions: ["global"],
    cost: { currency: "USD", unit: video ? "second" : "request", estimateMinor: null },
  };
}

function capabilityId(workspaceId: string, providerId: string, kind: string): string {
  const hash = createHash("sha256").update(`${workspaceId}:${providerId}:${kind}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
