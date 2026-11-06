import { createHash } from "node:crypto";

export const RENDER_SCHEMA_VERSION = "1.0" as const;
export const DEFAULT_RENDER_PROFILE: RenderProfile = Object.freeze({
  id: "vertical-1080x1920-30-h264",
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  audioSampleRate: 48_000,
  audioChannels: 2,
  captionSafeMarginPixels: 120,
  transition: "CUT",
  transitionDurationMs: 0,
});
export type RenderProfile = Readonly<{
  id: string;
  width: number;
  height: number;
  fps: number;
  videoCodec: "h264";
  audioCodec: "aac";
  audioSampleRate: number;
  audioChannels: 1 | 2;
  captionSafeMarginPixels: number;
  transition: "CUT" | "FADE";
  transitionDurationMs: number;
}>;
export type MediaStream = Readonly<{
  type: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
}>;
export type MediaInspection = Readonly<{ streams: readonly MediaStream[] }>;
export class MediaValidationError extends Error {
  public override readonly name = "MediaValidationError";
  public readonly errorCode = "INVALID_RENDER_MEDIA";
}
export class ProcessExecutionError extends Error {
  public override readonly name = "ProcessExecutionError";
  public readonly errorCode = "RENDER_PROCESS_FAILED";
}
export interface ProcessRunner {
  run(
    input: Readonly<{
      executable: "ffmpeg" | "ffprobe";
      argv: readonly string[];
      signal?: AbortSignal;
    }>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
export type CompositionInput = Readonly<{
  scenes: readonly Readonly<{
    path: string;
    durationMs: number;
    narrationPath?: string | undefined;
    image: boolean;
  }>[];
  mixAudioPaths: readonly string[];
  subtitlePath: string;
  outputPath: string;
}>;

export function parseSpawnedProcessReport(value: unknown): MediaInspection {
  if (typeof value !== "object" || value === null || !("streams" in value))
    throw new MediaValidationError("FFprobe report is missing streams");
  const streams = (value as { streams: unknown }).streams;
  if (!Array.isArray(streams)) throw new MediaValidationError("FFprobe streams must be an array");
  return {
    streams: streams.map((stream): MediaStream => {
      if (typeof stream !== "object" || stream === null)
        throw new MediaValidationError("FFprobe stream is invalid");
      const record = stream as Record<string, unknown>;
      const type = record.streams ?? record.codec_type;
      if (type !== "video" && type !== "audio")
        throw new MediaValidationError("Only video and audio streams are supported");
      const fps = parseFrameRate(record.r_frame_rate ?? record.avg_frame_rate);
      const durationSeconds = optionalPositiveNumber(record.duration, "duration");
      return {
        type,
        codec: requiredText(record.codec_name, "codec"),
        ...(type === "video"
          ? {
              width: positiveNumber(record.width, "width"),
              height: positiveNumber(record.height, "height"),
              fps: positiveNumber(fps, "fps"),
            }
          : {}),
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(type === "audio"
          ? {
              sampleRate: positiveNumber(record.sample_rate, "sample rate"),
              channels: positiveNumber(record.channels, "channels"),
            }
          : {}),
      };
    }),
  };
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new MediaValidationError(`FFprobe ${label} is missing`);
  return value;
}
function positiveNumber(value: unknown, label: string): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0)
    throw new MediaValidationError(`FFprobe ${label} must be positive`);
  return number;
}
function optionalPositiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === "N/A") return undefined;
  return positiveNumber(value, label);
}
function parseFrameRate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const [a, b] = value.split("/");
  return b === undefined ? Number(value) : Number(a) / Number(b);
}

export function validateMediaInspection(
  inspection: MediaInspection,
  profile: RenderProfile,
  durationSeconds: number,
  audioRequired: boolean,
): MediaInspection {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new MediaValidationError("Validated duration must be positive");
  const videos = inspection.streams.filter((stream) => stream.type === "video");
  const audios = inspection.streams.filter((stream) => stream.type === "audio");
  if (videos.length !== 1)
    throw new MediaValidationError("Source must contain exactly one video stream");
  const video = videos[0]!;
  if (video.width !== profile.width || video.height !== profile.height)
    throw new MediaValidationError(`Source dimensions must be ${profile.width}x${profile.height}`);
  if (video.codec !== profile.videoCodec)
    throw new MediaValidationError(`Source video codec must be ${profile.videoCodec}`);
  if (Math.abs((video.fps ?? 0) - profile.fps) >= 0.01)
    throw new MediaValidationError(`Source frame rate must be ${profile.fps}`);
  if (video.durationSeconds === undefined)
    throw new MediaValidationError("Validated video duration is missing");
  if (Math.abs(video.durationSeconds - durationSeconds) >= 0.051)
    throw new MediaValidationError(
      "Source video duration must match the requested composition duration",
    );
  if (audioRequired && audios.length !== 1)
    throw new MediaValidationError("Source must contain exactly one audio stream");
  if (audios.length > 1) throw new MediaValidationError("Source contains ambiguous audio streams");
  const audio = audios[0];
  if (audio) {
    if (audio.codec !== profile.audioCodec)
      throw new MediaValidationError(`Source audio codec must be ${profile.audioCodec}`);
    const audioDuration = audio.durationSeconds;
    if (audioDuration === undefined)
      throw new MediaValidationError("Validated audio duration is missing");
    if (Math.abs(audioDuration - durationSeconds) >= 0.051)
      throw new MediaValidationError(
        "Source audio duration must match the requested composition duration",
      );
  }
  if (
    audios.some(
      (stream) =>
        Math.abs((stream.sampleRate ?? 0) - profile.audioSampleRate) > 0.01 ||
        stream.channels !== profile.audioChannels,
    )
  )
    throw new MediaValidationError("Final audio sample rate and channels must match the profile");
  return inspection;
}
export function buildCompositionArguments(
  input: CompositionInput,
  profile: RenderProfile,
): readonly string[] {
  if (input.scenes.length === 0)
    throw new MediaValidationError("A composition requires at least one scene");
  assertSafePaths([
    input.subtitlePath,
    input.outputPath,
    ...input.scenes.map((scene) => scene.path),
    ...input.scenes.flatMap((scene) => (scene.narrationPath ? [scene.narrationPath] : [])),
    ...input.mixAudioPaths,
  ]);
  const argv = ["-hide_banner", "-nostdin", "-y"];
  const fileInputs = input.scenes.flatMap((scene) => {
    return scene.image
      ? [
          "-loop",
          "1",
          "-framerate",
          String(profile.fps),
          "-i",
          scene.path,
          ...(scene.narrationPath ? ["-i", scene.narrationPath] : []),
        ]
      : ["-i", scene.path, ...(scene.narrationPath ? ["-i", scene.narrationPath] : [])];
  });
  argv.push(...fileInputs);
  for (const path of input.mixAudioPaths) argv.push("-i", path);
  const filters: string[] = [];
  const visualSources: string[] = [];
  let nextInput = 0;
  for (const [sceneIndex, scene] of input.scenes.entries()) {
    const visual = `v${sceneIndex}`;
    filters.push(
      `[${nextInput}:v]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},setsar=1,trim=duration=${seconds(scene.durationMs)},setpts=PTS-STARTPTS,fps=${profile.fps},settb=AVTB[${visual}]`,
    );
    visualSources.push(`[${visual}]`);
    nextInput += 1 + (scene.narrationPath ? 1 : 0);
  }
  if (input.scenes.length === 1) filters.push(`${visualSources[0]}null[video]`);
  else if (profile.transition === "CUT")
    filters.push(`${visualSources.join("")}concat=n=${input.scenes.length}:v=1:a=0[video]`);
  else {
    const last = input.scenes.length - 1;
    for (let index = 0; index < last; index += 1) {
      const before = input.scenes
        .slice(0, index + 1)
        .reduce((total, scene) => total + scene.durationMs, 0);
      filters.push(
        `${index === 0 ? visualSources[0] : `[blend${index - 1}]`}${visualSources[index + 1]}xfade=transition=fade:duration=${seconds(profile.transitionDurationMs)}:offset=${seconds(before - profile.transitionDurationMs * (index + 1))}[${index === last - 1 ? "video" : `blend${index}`}]`,
      );
    }
  }
  filters.push(`[video]subtitles='${escapeFilterPath(input.subtitlePath)}'[outv]`);
  nextInput = 0;
  const speechSources: string[] = [];
  let totalDuration = 0;
  for (const [sceneIndex, scene] of input.scenes.entries()) {
    speechSources.push(`[a${sceneIndex}]`);
    if (scene.narrationPath) {
      filters.push(
        `[${nextInput + 1}:a]aresample=${profile.audioSampleRate},aformat=channel_layouts=stereo,apad=whole_dur=${seconds(scene.durationMs)},atrim=duration=${seconds(scene.durationMs)}[a${sceneIndex}]`,
      );
    } else
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=${profile.audioSampleRate},atrim=duration=${seconds(scene.durationMs)}[a${sceneIndex}]`,
      );
    nextInput += 1 + (scene.narrationPath ? 1 : 0);
    totalDuration += scene.durationMs;
  }
  const outputDuration = totalDuration - (input.scenes.length - 1) * profile.transitionDurationMs;
  if (profile.transition === "FADE" && input.scenes.length > 1) {
    const delayedSources: string[] = [];
    let offset = 0;
    for (let index = 0; index < speechSources.length; index += 1) {
      const delay = Math.round(offset);
      filters.push(`${speechSources[index]}adelay=${delay}|${delay}[d${index}]`);
      delayedSources.push(`[d${index}]`);
      offset +=
        input.scenes[index]!.durationMs -
        (index < speechSources.length - 1 ? profile.transitionDurationMs : 0);
    }
    filters.push(
      `${delayedSources.join("")}amix=inputs=${delayedSources.length}:duration=longest:normalize=0,atrim=duration=${seconds(outputDuration)}[speech]`,
    );
  } else {
    filters.push(`${speechSources.join("")}concat=n=${input.scenes.length}:v=0:a=1[speech]`);
  }
  const mixedSources: string[] = [];
  for (let index = 0; index < input.mixAudioPaths.length; index += 1) {
    filters.push(
      `[${nextInput + index}:a]aresample=${profile.audioSampleRate},aformat=channel_layouts=stereo,volume=0.35[mix${index}]`,
    );
    mixedSources.push(`[mix${index}]`);
  }
  filters.push(
    `[speech]${mixedSources.join("")}amix=inputs=${1 + mixedSources.length}:duration=first:normalize=0,alimiter=limit=0.95,atrim=duration=${seconds(outputDuration)}[aout]`,
  );
  argv.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[outv]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(profile.fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(profile.audioSampleRate),
    "-ac",
    String(profile.audioChannels),
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-metadata",
    "comment=",
    "-t",
    seconds(outputDuration),
    input.outputPath,
  );
  return argv;
}
export function subtitleDocument(
  scenes: readonly Readonly<{
    durationMs: number;
    captions: readonly Readonly<{ text: string; startMs: number; endMs: number }>[];
  }>[],
  profile: RenderProfile,
): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ReelForge,Arial,64,&H00FFFFFF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,${profile.captionSafeMarginPixels},${profile.captionSafeMarginPixels},${profile.captionSafeMarginPixels},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  let sceneStart = 0;
  for (const [index, scene] of scenes.entries()) {
    for (const caption of scene.captions) {
      if (
        !caption.text.trim() ||
        caption.startMs < 0 ||
        caption.endMs <= caption.startMs ||
        caption.endMs > scene.durationMs
      )
        throw new MediaValidationError("Caption timing must be non-empty and inside its scene");
      lines.push(
        `Dialogue: 0,${captionTime(sceneStart + caption.startMs)},${captionTime(sceneStart + caption.endMs)},ReelForge,,0,0,0,,${caption.text.replace(/\r?\n/g, "\\N").replace(/[{}]/g, "")}`,
      );
    }
    sceneStart += scene.durationMs - (index < scenes.length - 1 ? profile.transitionDurationMs : 0);
  }
  return `${lines.join("\n")}\n`;
}
export function canonicalRenderFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}
function assertSafePaths(paths: readonly string[]): void {
  if (paths.some((path) => !path || path.startsWith("-") || path.includes("\0")))
    throw new MediaValidationError("FFmpeg paths must be safe local files");
}
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
function captionTime(milliseconds: number): string {
  return `${Math.floor(milliseconds / 3_600_000)}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(Math.floor(milliseconds / 10) % 100).padStart(2, "0")}`;
}
