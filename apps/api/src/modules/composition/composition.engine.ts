import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  buildCompositionArguments,
  MediaValidationError,
  parseSpawnedProcessReport,
  ProcessExecutionError,
  subtitleDocument,
  validateMediaInspection,
  validateSourceImageDimensions,
  type MediaInspection,
  type ProcessRunner,
} from "@reelforge/media";
import { AssetService } from "../asset/asset.service.js";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { RenderCompositionInput, RenderProfile } from "./composition.types.js";
import { duration } from "./composition.validation.js";

export const COMPOSITION_RUNNER = "COMPOSITION_RUNNER";
export type RenderedArtifact = Readonly<{
  kind: "VIDEO" | "MANIFEST" | "COVER";
  body: Buffer;
  mediaType: string;
  filename: string;
  durationMs: number | null;
  selectedFrame?: {
    assetId: string;
    assetVersion: number;
    timestampMs: number;
  };
}>;
export interface CompositionEnginePort {
  execute(
    context: WorkspaceContext,
    jobId: string,
    input: RenderCompositionInput,
    signal?: AbortSignal,
  ): Promise<readonly RenderedArtifact[]>;
}

@Injectable()
export class SpawnProcessRunner implements ProcessRunner {
  public run(
    input: Readonly<{
      executable: "ffmpeg" | "ffprobe";
      argv: readonly string[];
      signal?: AbortSignal;
    }>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const configured =
        input.executable === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
      const executable = configured?.trim() || input.executable;
      const child = spawn(executable, [...input.argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (part: string): void => {
        if (stdout.length < 4_000_000) stdout += part;
      });
      child.stderr.setEncoding("utf8").on("data", (part: string): void => {
        if (stderr.length < 4_000_000) stderr += part;
      });
      let settled = false;
      const abort = (): boolean => child.kill("SIGTERM");
      const cleanup = (): void => {
        input.signal?.removeEventListener("abort", abort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      child.once("error", (error: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            new ServiceUnavailableException(
              `${input.executable} is unavailable: ${error.code ?? error.message}`,
              { cause: error },
            ),
          ),
        ),
      );
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (code, codeSignal) =>
        finish(() =>
          input.signal?.aborted
            ? reject(Object.assign(new Error("Render canceled"), { name: "AbortError" }))
            : resolve({ stdout, stderr, exitCode: code ?? (codeSignal ? 1 : 0) }),
        ),
      );
    });
  }
}

@Injectable()
export class CompositionEngine implements CompositionEnginePort {
  public constructor(
    @Inject(COMPOSITION_RUNNER) private readonly runner: ProcessRunner,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly assets: AssetService,
  ) {}

  public async execute(
    context: WorkspaceContext,
    jobId: string,
    input: RenderCompositionInput,
    signal?: AbortSignal,
  ): Promise<readonly RenderedArtifact[]> {
    const root = await mkdtemp(join(tmpdir(), "reelforge-m10-"));
    try {
      ensureActive(signal);
      const sceneInputs: Array<{
        path: string;
        narrationPath?: string;
        sourceAudio: boolean;
        image: boolean;
        durationMs: number;
      }> = [];
      const mixAudioPaths: string[] = [];
      for (const [index, scene] of input.scenes.entries()) {
        const visualPath = join(root, `scene-${index}.input`);
        const visual = await this.read(
          context,
          scene.assetId,
          scene.assetVersion,
          visualPath,
          signal,
        );
        const videos = visual.streams.filter((stream) => stream.type === "video");
        const audios = visual.streams.filter((stream) => stream.type === "audio");
        if (videos.length !== 1 || audios.length > 1 || visual.streams.length > 2)
          invalid("Scene must have exactly one video stream and at most one optional audio stream");
        const stream = videos[0]!;
        if (scene.image) {
          if (stream.durationSeconds !== undefined || audios.length !== 0)
            invalid("Still inputs must be one PNG without an audio stream");
          validateSourceImageDimensions(stream, input.profile);
        } else {
          validateSourceVisual(stream, input.profile, scene.durationMs);
        }
        let narrationPath: string | undefined;
        if (scene.narrationAssetId !== undefined) {
          if (scene.narrationAssetVersion === undefined)
            invalid("Narration version must be pinned");
          narrationPath = join(root, `narration-${index}.m4a`);
          const narration = await this.read(
            context,
            scene.narrationAssetId,
            scene.narrationAssetVersion,
            narrationPath,
            signal,
          );
          if (
            narration.streams.length !== 1 ||
            narration.streams[0]!.type !== "audio" ||
            narration.streams[0]!.durationSeconds === undefined ||
            narration.streams[0]!.durationSeconds + 0.001 < scene.durationMs / 1000
          )
            invalid("Narration must be one audio stream covering the full scene");
        }
        sceneInputs.push({
          path: visualPath,
          ...(narrationPath ? { narrationPath } : {}),
          sourceAudio: audios.length === 1 && narrationPath === undefined,
          image: scene.image,
          durationMs: scene.durationMs,
        });
      }
      for (const [index, audio] of input.audio.entries()) {
        const path = join(root, `mix-${index}.m4a`);
        const probe = await this.read(context, audio.assetId, audio.assetVersion, path, signal);
        if (probe.streams.length !== 1 || probe.streams[0]!.type !== "audio")
          invalid("Music/SFX must be one audio stream");
        const stream = probe.streams[0]!;
        if (stream.sampleRate !== input.profile.audioSampleRate && stream.sampleRate !== 44_100)
          invalid("Music/SFX source sample rate must be PCM-decodable or match the output profile");
        if (
          stream.channels === undefined ||
          stream.channels < 1 ||
          stream.channels > 2 ||
          stream.durationSeconds === undefined ||
          stream.durationSeconds + 0.001 < duration(input) / 1000
        )
          invalid("Music/SFX must have valid channels and cover the output duration");
        mixAudioPaths.push(path);
      }
      const subtitlePath = join(root, "captions.ass");
      await writeFile(subtitlePath, subtitleDocument(input.scenes, input.profile));
      const outputPath = join(root, "final.mp4");
      await this.call(
        "ffmpeg",
        buildCompositionArguments(
          { scenes: sceneInputs, mixAudioPaths, subtitlePath, outputPath },
          input.profile,
        ),
        signal,
      );
      const finalProbe = await this.call(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", outputPath],
        signal,
      );
      let finalMedia: MediaInspection;
      try {
        finalMedia = parseSpawnedProcessReport(JSON.parse(finalProbe));
        validateMediaInspection(finalMedia, input.profile, duration(input) / 1000, true);
      } catch (error) {
        invalid("Final FFmpeg output failed the requested technical profile", error);
      }
      const body = await readFile(outputPath);
      if (body.length === 0) invalid("FFmpeg produced empty video bytes");
      const finalDuration = finalMedia.streams.find(
        (stream) => stream.type === "video",
      )!.durationSeconds;
      if (finalDuration === undefined) invalid("Final video duration is missing");
      const videoDurationMs = Math.round(finalDuration * 1000);
      const artifacts: RenderedArtifact[] = [
        {
          kind: "VIDEO",
          body,
          mediaType: "video/mp4",
          filename: "final.mp4",
          durationMs: videoDurationMs,
        },
      ];
      for (const [index, frame] of input.coverFrames.entries()) {
        const filename = `cover-${String(index + 1).padStart(2, "0")}.jpg`;
        await this.call(
          "ffmpeg",
          [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss",
            (frame.timestampMs / 1000).toFixed(3),
            "-i",
            outputPath,
            "-frames:v",
            "1",
            "-update",
            "1",
            join(root, filename),
          ],
          signal,
        );
        const coverBody = await readFile(join(root, filename));
        if (!coverBody.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))
          invalid("Cover candidates must be real JPEG frames");
        artifacts.push({
          kind: "COVER",
          body: coverBody,
          mediaType: "image/jpeg",
          filename: `cover-${index + 1}.jpg`,
          durationMs: null,
          selectedFrame: frame,
        });
      }
      artifacts.push({
        kind: "MANIFEST",
        body: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: "1.0",
              jobId,
              title: input.title,
              renderSeed: input.renderSeed,
              renderProfile: input.profile,
              sourceMediaPackage: input.sourceMediaPackage,
              pinnedInputs: {
                scenes: input.scenes,
                audio: input.audio,
                coverFrames: input.coverFrames,
              },
              video: {
                filename: "final.mp4",
                mediaType: "video/mp4",
                byteSize: body.length,
                checksumSha256: createHash("sha256").update(body).digest("hex"),
                durationMs: videoDurationMs,
              },
              artifactOrder: ["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"],
            },
            null,
            2,
          ) + "\n",
        ),
        mediaType: "application/json",
        filename: "manifest.json",
        durationMs: null,
      });
      ensureActive(signal);
      return artifacts;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async read(
    context: WorkspaceContext,
    assetId: string,
    version: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<MediaInspection> {
    const reference = await this.assets.getReference(context, { assetId, version });
    if (reference.assetId !== assetId || reference.version !== version)
      invalid("Pinned source asset does not match the returned reference");
    if (!reference.licenseType || !reference.rightsHolder)
      invalid("All render inputs require license and rights metadata");
    const stored = await this.storage.getObject({
      workspaceId: context.workspaceId,
      objectKey: reference.objectKey,
    });
    if (
      stored.length !== reference.byteSize ||
      createHash("sha256").update(stored).digest("hex") !== reference.checksumSha256
    )
      invalid("Stored source bytes do not match pinned checksum and byte size");
    const supported =
      reference.mediaType === "image/png" ||
      reference.mediaType === "video/mp4" ||
      reference.mediaType === "audio/aac" ||
      reference.mediaType === "audio/mpeg" ||
      reference.mediaType === "audio/wav";
    if (!supported) invalid(`Unsupported pinned media type ${reference.mediaType}`);
    await writeFile(path, stored);
    const probe = await this.call(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", path],
      signal,
    );
    try {
      return parseSpawnedProcessReport(JSON.parse(probe));
    } catch (error) {
      invalid("Pinned source media failed technical validation", error);
    }
  }

  private async call(
    executable: "ffmpeg" | "ffprobe",
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.runner.run({ executable, argv, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0)
      throw new ProcessExecutionError(`${executable} did not complete successfully`, {
        cause: new Error(result.stderr.slice(0, 1000)),
      });
    return result.stdout;
  }
}

function validateSourceVisual(
  stream: MediaInspection["streams"][number],
  profile: RenderProfile,
  durationMs: number,
): void {
  if (stream.type !== "video") invalid("Scene visual must be a video stream");
  if (stream.codec !== profile.videoCodec)
    invalid("Video source codec must match the output profile");
  if (stream.width !== profile.width || stream.height !== profile.height)
    invalid("Video source dimensions must match the output profile");
  if ((stream.fps ?? 0) < profile.fps)
    invalid("Video source frame rate must provide the requested output cadence");
  if (stream.durationSeconds === undefined || stream.durationSeconds + 0.001 < durationMs / 1000)
    invalid("Video source duration must cover the entire scene");
}

function invalid(message: string, cause?: unknown): never {
  throw new MediaValidationError(message, { cause });
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Render canceled"), { name: "AbortError" });
}
