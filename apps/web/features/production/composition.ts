import type { SceneMediaPackage, ScriptRevision } from "./model";

type RenderScene = {
  sceneId: string;
  assetId: string;
  assetVersion: number;
  image: boolean;
  durationMs: number;
  captions: [];
  narrationAssetId?: string;
  narrationAssetVersion?: number;
};
export type RenderInput = {
  schemaVersion: "1.0";
  title: string;
  profile: {
    id: "vertical-1080x1920-30-h264";
    width: 1080;
    height: 1920;
    fps: 30;
    videoCodec: "h264";
    audioCodec: "aac";
    audioSampleRate: 48000;
    audioChannels: 2;
    captionSafeMarginPixels: 120;
    transition: "CUT";
    transitionDurationMs: 0;
  };
  sourceMediaPackage: {
    jobId: string;
    scriptId: string;
    scriptRevision: number;
    schemaVersion: "1.0";
  };
  scenes: RenderScene[];
  audio: [];
  coverFrames: { assetId: string; assetVersion: number; timestampMs: number }[];
  renderSeed: string;
};

export function makeRenderInput(
  job: SceneMediaPackage,
  revision: ScriptRevision,
  seed: string,
): RenderInput {
  if (
    job.status !== "SUCCEEDED" ||
    job.scriptRevision !== revision.revision ||
    !job.scenes.length ||
    job.scenes.length !== revision.document.scenes.length
  )
    throw new Error(
      "A complete successful production package and its pinned script revision are required.",
    );
  const scenes = [...job.scenes]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((scene, index): RenderScene => {
      const script = revision.document.scenes[index];
      if (
        !script ||
        script.id !== scene.sceneId ||
        scene.status !== "SUCCEEDED" ||
        scene.outputs.some((output) => output.status !== "SUCCEEDED" && output.status !== "REUSED")
      )
        throw new Error("Every scene must match the pinned revision and have complete outputs.");
      const visual =
        scene.outputs.find((output) => output.kind === "IMAGE") ??
        scene.outputs.find((output) => output.kind === "VIDEO");
      const voices = scene.outputs.filter(
        (output) => output.kind === "NARRATION" || output.kind === "DIALOGUE",
      );
      if (
        !visual?.assetId ||
        !visual.assetVersion ||
        voices.length > 1 ||
        voices.some((voice) => !voice.assetId || !voice.assetVersion)
      )
        throw new Error("Each scene needs a pinned visual and at most one voice output.");
      const durationMs = Math.round(script.durationSeconds * 1000);
      if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 300000)
        throw new Error("A scene duration is outside the supported render range.");
      const voice = voices[0];
      return {
        sceneId: scene.sceneId,
        assetId: visual.assetId,
        assetVersion: visual.assetVersion,
        image: visual.kind === "IMAGE",
        durationMs,
        captions: [],
        ...(voice?.assetId && voice.assetVersion
          ? { narrationAssetId: voice.assetId, narrationAssetVersion: voice.assetVersion }
          : {}),
      };
    });
  const first = scenes[0];
  if (!first || !revision.document.title.trim() || seed.length < 8)
    throw new Error("The render is missing a title, scene, or seed.");
  return {
    schemaVersion: "1.0",
    title: revision.document.title,
    profile: {
      id: "vertical-1080x1920-30-h264",
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      audioSampleRate: 48000,
      audioChannels: 2,
      captionSafeMarginPixels: 120,
      transition: "CUT",
      transitionDurationMs: 0,
    },
    sourceMediaPackage: {
      jobId: job.jobId,
      scriptId: job.scriptId,
      scriptRevision: job.scriptRevision,
      schemaVersion: "1.0",
    },
    scenes,
    audio: [],
    coverFrames: [{ assetId: first.assetId, assetVersion: first.assetVersion, timestampMs: 0 }],
    renderSeed: seed,
  };
}
