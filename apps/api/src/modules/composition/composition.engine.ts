import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  buildCompositionArguments,
  parseSpawnedProcessReport,
  subtitleDocument,
  validateMediaInspection,
  type MediaInspection,
  type ProcessRunner,
} from "@reelforge/media";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import { AssetService } from "../asset/asset.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { RenderCompositionInput } from "./composition.types.js";
import { duration } from "./composition.validation.js";
export const COMPOSITION_RUNNER = "COMPOSITION_RUNNER";
export type RenderedArtifact = Readonly<{
  kind: "VIDEO" | "MANIFEST" | "COVER";
  body: Buffer;
  mediaType: string;
  filename: string;
  durationMs: number | null;
  selectedFrame?: { assetId: string; assetVersion: number; timestampMs: number } | undefined;
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
      const child = spawn(input.executable, [...input.argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8").on("data", (part: string) => {
        if (stdout.length < 4_000_000) stdout += part;
      });
      child.stderr.setEncoding("utf8").on("data", (part: string) => {
        if (stderr.length < 4_000_000) stderr += part;
      });
      child.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          new ServiceUnavailableException(
            `${input.executable} is unavailable: ${error.code ?? error.message}`,
            { cause: error },
          ),
        ),
      );
      input.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.once("close", (code, codeSignal) =>
        input.signal?.aborted
          ? reject(Object.assign(new Error("Render canceled"), { name: "AbortError" }))
          : resolve({ stdout, stderr, exitCode: code ?? (codeSignal ? 1 : 0) }),
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
      const sceneInputs = [];
      const mixAudioPaths = [];
      for (const [index, scene] of input.scenes.entries()) {
        const inputPath = join(root, `scene-${index}.input`),
          visualPath = join(root, `scene-${index}.input`);
        const visual = await this.read(
          context,
          scene.assetId,
          scene.assetVersion,
          inputPath,
          signal,
        );
        if (
          visual.streams.filter((stream) => stream.type === "video").length !== 1 ||
          visual.streams.length > 2
        )
          throw new Error(
            "Scene must have exactly one video stream and at most one optional audio stream",
          );

        const durationSeconds = visual.streams.find(
          (stream) => stream.type === "video",
        )!.durationSeconds;
        if (durationSeconds + 0.001 < scene.durationMs / 1000)
          throw new Error("Scene visual source is shorter than its requested duration");
        await writeFile(visualPath, await this.readStored(context, this.objectKey(scene.assetId)));
        let narrationPath: string | undefined;
        if (scene.narrationAssetId !== undefined) {
          if (scene.narrationAssetVersion === undefined)
            throw new Error("Narration version must be pinned");
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
            narration.streams[0]!.durationSeconds + 0.001 < scene.durationMs / 1000
          )
            throw new Error("Narration must be one audio stream covering the full scene");
          await writeFile(
            narrationPath,
            await this.readStored(context, this.objectKey(scene.narrationAssetId)),
          );
        }
        sceneInputs.push({
          path: visualPath,
          narrationPath,
          image: scene.image,
          durationMs: scene.durationMs,
        });
      }
      for (const [index, audio] of input.audio.entries()) {
        const path = join(root, `mix-${index}.m4a`),
          probe = await this.read(context, audio.assetId, audio.assetVersion, path, signal);
        if (probe.streams.length !== 1 || probe.streams[0]!.type !== "audio")
          throw new Error("Music/SFX must be one audio stream");
        if (probe.streams[0]!.durationSeconds + 0.001 < duration(input) / 1000)
          throw new Error("Music/SFX must cover the output duration");
        await writeFile(path, await this.readStored(context, this.objectKey(audio.assetId)));
        mixAudioPaths.push(path);
      }
      // Every frame candidate must resolve to a successful pinned scene visual.
      for (const frame of input.coverFrames) {
        const ref = await this.assets.getReference(context, {
          assetId: frame.assetId,
          version: frame.assetVersion,
        });
        const scene = input.scenes.find(
          (scene) => scene.assetId === ref.assetId && scene.assetVersion === ref.version,
        );
        if (!scene)
          throw new Error(
            "Cover frames must reference an approved scene visual pinned in this composition",
          );
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
      const finalMedia = parseSpawnedProcessReport(JSON.parse(finalProbe));
      validateMediaInspection(finalMedia, input.profile, duration(input) / 1000, true);
      const body = await readFile(outputPath);
      if (body.length === 0) throw new Error("FFmpeg produced empty video bytes");
      const videoDurationMs = Math.round(
        finalMedia.streams.find((stream) => stream.type === "video")!.durationSeconds * 1000,
      );
      const artifacts: RenderedArtifact[] = [
        {
          kind: "VIDEO",
          body,
          mediaType: "video/mp4",
          filename: "final.mp4",
          durationMs: videoDurationMs,
        },
      ];
      const select = input.coverFrames
        .map((frame) => `gte(t\\,${(frame.timestampMs / 1000).toFixed(3)})`)
        .join("+");
      await this.call(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          "-i",
          outputPath,
          "-vf",
          `select='${select}'`,
          "-fps_mode",
          "vfr",
          "-frames:v",
          String(input.coverFrames.length),
          join(root, "cover-%02d.jpg"),
        ],
        signal,
      );
      for (let index = 0; index < input.coverFrames.length; index++) {
        const coverBody = await readFile(
          join(root, `cover-${String(index + 1).padStart(2, "0")}.jpg`),
        );
        if (!coverBody.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))
          throw new Error("Cover candidates must be real JPEG frames");
        artifacts.push({
          kind: "COVER",
          body: coverBody,
          mediaType: "image/jpeg",
          filename: `cover-${index + 1}.jpg`,
          durationMs: null,
          selectedFrame: input.coverFrames[index],
        });
      }
      const checksum = createHash("sha256").update(body).digest("hex");
      const manifest = Buffer.from(
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
              checksumSha256: checksum,
              durationMs: videoDurationMs,
            },
            artifactOrder: ["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"],
          },
          null,
          2,
        ) + "\n",
      );
      artifacts.push({
        kind: "MANIFEST",
        body: manifest,
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
      throw new Error("Pinned source asset does not match the returned reference");
    if (!reference.licenseType || !reference.rightsHolder)
      throw new Error("All render inputs require license and rights metadata");
    this.objectKeyCache.set(assetId, reference.objectKey);
    const stored = await this.readStored(context, reference.objectKey);
    if (
      stored.length !== reference.byteSize ||
      createHash("sha256").update(stored).digest("hex") !== reference.checksumSha256
    )
      throw new Error("Stored source bytes do not match pinned checksum and byte size");
    const supported =
      reference.mediaType === "image/png" ||
      reference.mediaType === "video/mp4" ||
      reference.mediaType === "audio/aac" ||
      reference.mediaType === "audio/mpeg" ||
      reference.mediaType === "audio/wav";
    if (!supported) throw new Error(`Unsupported pinned media type ${reference.mediaType}`);
    const probe = await this.call(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", path],
      signal,
    );
    return parseSpawnedProcessReport(JSON.parse(probe));
  }
  private readonly objectKeyCache = new Map<string, string>();
  private objectKey(assetId: string): string {
    const key = this.objectKeyCache.get(assetId);
    if (!key) throw new Error("Source reference was not resolved and bound");
    return key;
  }
  private async readStored(context: WorkspaceContext, objectKey: string): Promise<Buffer> {
    return this.storage.getObject({ workspaceId: context.workspaceId, objectKey });
  }
  private async call(
    executable: "ffmpeg" | "ffprobe",
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.runner.run({ executable, argv, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0)
      throw new Error(
        `${executable} failed with exit ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
      );
    return result.stdout;
  }
}
function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Render canceled"), { name: "AbortError" });
}
