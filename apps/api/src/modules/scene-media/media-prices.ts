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
export function imageCallCents(): number {
  return reservationCents({ currency: "USD", microUsd: MEDIA_OVERHEAD.imageMicroUsd });
}
export function textCallCents(): number {
  return reservationCents({
    currency: "USD",
    microUsd: Math.ceil(MEDIA_OVERHEAD.textMicroUsd / 3),
  });
}
export function audioCosts(seconds: number): { narration: number; music: number } {
  return {
    narration: reservationCents({
      currency: "USD",
      microUsd: Math.ceil((seconds / 10) * MEDIA_OVERHEAD.ttsPerTenSecondsMicroUsd),
    }),
    music: reservationCents({ currency: "USD", microUsd: MEDIA_OVERHEAD.musicMicroUsd }),
  };
}

export function plannedRunOverheadCents(
  shots: readonly Pick<ShotSpec, "durationSeconds">[],
  planningSpentMinor = 3 * textCallCents(),
): number {
  if (!Number.isSafeInteger(planningSpentMinor) || planningSpentMinor < 0)
    throw new Error("Invalid recorded planning cost");
  const audio = audioCosts(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0));
  return (
    planningSpentMinor +
    shots.length * imageCallCents() +
    audio.narration +
    audio.music +
    textCallCents()
  );
}
