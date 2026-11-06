import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RENDER_PROFILE, type ProcessRunner } from "@reelforge/media";
import { AssetService } from "../asset/asset.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { CompositionEngine, SpawnProcessRunner } from "./composition.engine.js";
import type { RenderCompositionInput } from "./composition.types.js";

const runner = new SpawnProcessRunner();
const suite = describe.skipIf(
  process.env.FFMPEG_PATH === undefined || process.env.FFPROBE_PATH === undefined,
);

suite("CompositionEngine real FFmpeg export", () => {
  const workspaceId = randomUUID();
  const context: WorkspaceContext = { workspaceId, userId: randomUUID(), role: "OWNER" };
  const imageId = randomUUID();
  const audioId = randomUUID();
  const secondImageId = randomUUID();
  const musicId = randomUUID();
  const sources = new Map<string, Buffer>();
  let root = "";
  let storage: StoragePort;
  let input: RenderCompositionInput;
  let assets: AssetService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "reelforge-m10-ffmpeg-test-"));
    storage = new LocalFilesystemStorageAdapter(join(root, "storage"));
    for (const [index, color] of ["red", "blue"].entries()) {
      const key = `source-${index}.png`;
      const result = await runner.run({
        executable: "ffmpeg",
        argv: [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=64x64:d=0.2`,
          "-frames:v",
          "1",
          "-update",
          "1",
          join(root, key),
        ],
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      const png = await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(root, key)),
      );
      sources.set(key, png);
    }
    const musicPath = join(root, "music.wav");
    await runner.run({
      executable: "ffmpeg",
      argv: [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=3",
        "-c:a",
        "pcm_s16le",
        musicPath,
      ],
    });
    sources.set(
      "music.wav",
      await import("node:fs/promises").then(({ readFile }) => readFile(musicPath)),
    );
    const wavPath = join(root, "narration.wav");
    const audio = await runner.run({
      executable: "ffmpeg",
      argv: [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1.5",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
    });
    if (audio.exitCode !== 0) throw new Error(audio.stderr);
    sources.set(
      "narration.wav",
      await import("node:fs/promises").then(({ readFile }) => readFile(wavPath)),
    );
    for (const [objectKey, body] of sources) {
      await storage.putObject({
        workspaceId,
        objectKey,
        body,
        contentType: objectKey.endsWith(".wav") ? "audio/wav" : "image/png",
      });
    }
    assets = {
      getReference: async (
        _context: WorkspaceContext,
        request: { assetId: string; version: number },
      ) => {
        const isAudio = request.assetId === audioId;
        const objectKey =
          request.assetId === musicId
            ? "music.wav"
            : isAudio
              ? "narration.wav"
              : request.assetId === imageId
                ? "source-0.png"
                : "source-1.png";
        const source = sources.get(objectKey)!;
        return {
          assetId: request.assetId,
          version: request.version,
          objectKey,
          checksumSha256: createHash("sha256").update(source).digest("hex"),
          byteSize: source.length,
          mediaType: isAudio ? "audio/wav" : "image/png",
          ownership: "USER_UPLOADED",
          licenseType: "CC0-1.0",
          licenseTerms: "fixture",
          rightsHolder: "local test",
        };
      },
    } as unknown as AssetService;
    input = {
      schemaVersion: "1.0",
      title: "Real local composition",
      profile: DEFAULT_RENDER_PROFILE,
      sourceMediaPackage: {
        jobId: randomUUID(),
        scriptId: randomUUID(),
        scriptRevision: 1,
        schemaVersion: "1.0",
      },
      scenes: [0, 1].map((index) => ({
        sceneId: `scene-${index}`,
        assetId: index === 0 ? imageId : secondImageId,
        assetVersion: 1,
        image: true,
        durationMs: 1000,
        narrationAssetId: index === 0 ? audioId : undefined,
        narrationAssetVersion: index === 0 ? 1 : undefined,
        captions: [{ text: `Scene ${index}`, startMs: 0, endMs: 800 }],
      })),
      audio: [],
      coverFrames: [
        { assetId: imageId, assetVersion: 1, timestampMs: 600 },
        { assetId: secondImageId, assetVersion: 1, timestampMs: 1400 },
      ],
      renderSeed: "local-ffmpeg-test",
    };
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("writes source bytes before probing and produces a validated MP4, cover, and manifest", async () => {
    const recordingRunner: ProcessRunner = {
      run: async (request) => {
        const output = await runner.run(request);
        if (output.exitCode !== 0) throw new Error(output.stderr.slice(-6000));
        if (request.executable === "ffprobe") {
          const report = JSON.parse(output.stdout) as { streams: Array<Record<string, unknown>> };
          const video = report.streams.find((stream) => stream.codec_type === "video");
          if (video?.codec_name === "h264") {
            expect(video).toMatchObject({
              width: 1080,
              height: 1920,
              pix_fmt: "yuv420p",
              r_frame_rate: "30/1",
            });
            expect(report.streams.filter((stream) => stream.codec_type === "audio")).toHaveLength(
              1,
            );
            expect(report.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
            });
          }
        }
        return output;
      },
    };
    const local = new CompositionEngine(recordingRunner, storage, assets);
    const artifacts = await local.execute(context, randomUUID(), input);
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "COVER",
      "COVER",
      "MANIFEST",
      "VIDEO",
    ]);
    for (const artifact of artifacts) {
      expect(artifact.body.length).toBeGreaterThan(0);
    }
    const video = artifacts.find((artifact) => artifact.kind === "VIDEO")!;
    expect(video.durationMs).toBe(2000);
    const manifest = JSON.parse(
      artifacts.find((artifact) => artifact.kind === "MANIFEST")!.body.toString("utf8"),
    ) as Record<string, unknown>;
    expect(manifest.video).toMatchObject({
      checksumSha256: createHash("sha256").update(video.body).digest("hex"),
      durationMs: 2000,
    });
    const second = await local.execute(context, randomUUID(), input);
    const secondVideo = second.find((artifact) => artifact.kind === "VIDEO")!;
    expect(createHash("sha256").update(secondVideo.body).digest("hex")).toBe(
      createHash("sha256").update(video.body).digest("hex"),
    );
  }, 120_000);

  it("renders a fade with licensed music and two distinct exact cover frames", async () => {
    const commands: string[][] = [];
    const recording: ProcessRunner = {
      run: async (request) => {
        if (request.argv[0] === "-hide_banner") commands.push(request.argv as string[]);
        const output = await runner.run(request);
        if (output.exitCode !== 0) throw new Error(output.stderr.slice(-6000));
        return output;
      },
    };
    const local = new CompositionEngine(recording, storage, assets);
    const fadeInput: RenderCompositionInput = {
      ...input,
      profile: { ...DEFAULT_RENDER_PROFILE, transition: "FADE", transitionDurationMs: 400 },
      audio: [{ kind: "MUSIC", assetId: musicId, assetVersion: 1 }],
      coverFrames: [
        { assetId: imageId, assetVersion: 1, timestampMs: 500 },
        { assetId: secondImageId, assetVersion: 1, timestampMs: 800 },
      ],
    };
    const jobId = randomUUID();
    const artifacts = await local.execute(context, jobId, fadeInput);
    const video = artifacts.find((artifact) => artifact.kind === "VIDEO")!;
    expect(video.durationMs).toBe(1600);
    expect(artifacts.filter((artifact) => artifact.kind === "COVER")).toHaveLength(2);
    const covers = artifacts.filter((artifact) => artifact.kind === "COVER");
    expect(createHash("sha256").update(covers[0]!.body).digest("hex")).not.toBe(
      createHash("sha256").update(covers[1]!.body).digest("hex"),
    );
    const manifest = JSON.parse(
      artifacts.find((artifact) => artifact.kind === "MANIFEST")!.body.toString("utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      jobId,
      renderProfile: fadeInput.profile,
      pinnedInputs: { audio: fadeInput.audio, coverFrames: fadeInput.coverFrames },
    });
    expect(manifest.video).toMatchObject({
      durationMs: 1600,
      checksumSha256: createHash("sha256").update(video.body).digest("hex"),
    });
    expect(
      commands.some((arguments_) =>
        arguments_.some((argument) =>
          argument.includes("xfade=transition=fade:duration=0.400:offset=0.600"),
        ),
      ),
    ).toBe(true);
  }, 120_000);
});
