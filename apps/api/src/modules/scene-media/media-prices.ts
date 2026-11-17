import {
  capabilityCatalog,
  reservationCents,
  secondsCost,
  GrokVideo,
  ProviderHttp,
  type ProviderModels,
  type Money,
} from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
/** Planning allowance from locked #112 calculator; USD micros, not per-call video rates. */
export const MEDIA_OVERHEAD = Object.freeze({
  imageMicroUsd: 33600,
  textMicroUsd: 500000,
  ttsPerTenSecondsMicroUsd: 2250,
  musicMicroUsd: 80000,
  initialImages: 3,
  imagesPerShot: 2,
});
const models = (): ProviderModels => ({
  video: process.env.GEMINI_VIDEO_MODEL ?? "",
  image: process.env.GEMINI_IMAGE_MODEL ?? "",
  text: process.env.GEMINI_TEXT_MODEL ?? "",
  tts: process.env.GEMINI_TTS_MODEL ?? "",
  music: process.env.GEMINI_MUSIC_MODEL ?? "",
  xaiVideo: process.env.XAI_VIDEO_MODEL ?? "",
});
export function mediaCatalog(
  workspaceId = "00000000-0000-4000-8000-000000000000",
): ReturnType<typeof capabilityCatalog> {
  // Catalog-only pricing does not require secrets or dispatch a model. Runtime ports require configuration.
  return capabilityCatalog(workspaceId, models(), { gemini: false, xai: false });
}
export function imageSurcharge(): number {
  const capability = mediaCatalog().find(
    (row) => row.providerId === "xai" && row.kind === "VIDEO",
  )!;
  const port = new GrokVideo(
    new ProviderHttp("", "xai"),
    {
      save: async (): Promise<never> => {
        throw new Error("Estimate only");
      },
    },
    capability,
    { resolve: async (): Promise<never[]> => [] },
  );
  const spec: ShotSpec = {
    id: capability.id,
    workspaceId: capability.workspaceId,
    schemaVersion: "1.0",
    runId: capability.id,
    ordinal: 0,
    version: 1,
    durationSeconds: 3,
    keyframePrompt: "estimate",
    motionPrompt: "estimate",
    onScreenText: "",
    continuityNotes: [],
    firstFrameFrom: null,
    negativePrompt: "",
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
  return (
    port.estimate({ ...spec, references: [{ referenceAssetId: capability.id, version: 1 }] })
      .microUsd - port.estimate(spec).microUsd
  );
}
export function clipMoney(
  shot: Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>,
  fallback: boolean,
): Money {
  const cap = mediaCatalog().find(
    (row) => row.kind === "VIDEO" && row.providerId === (fallback ? "xai" : "gemini"),
  )!;
  const cost = secondsCost(shot.durationSeconds, cap.pricePerSecond["720p"]!);
  // One generated keyframe, or first + last pinned frames for a continuity shot, plus channel refs.
  const images = (shot.references?.length ?? 0) + (shot.firstFrameFrom ? 2 : 1);
  return { ...cost, microUsd: cost.microUsd + (fallback ? images * imageSurcharge() : 0) };
}
export function overheadCents(shots: readonly Pick<ShotSpec, "durationSeconds">[]): number {
  const seconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  return reservationCents({
    currency: "USD",
    microUsd: Math.ceil(
      (MEDIA_OVERHEAD.initialImages + MEDIA_OVERHEAD.imagesPerShot * shots.length) *
        MEDIA_OVERHEAD.imageMicroUsd +
        MEDIA_OVERHEAD.textMicroUsd +
        (seconds / 10) * MEDIA_OVERHEAD.ttsPerTenSecondsMicroUsd +
        MEDIA_OVERHEAD.musicMicroUsd,
    ),
  });
}
