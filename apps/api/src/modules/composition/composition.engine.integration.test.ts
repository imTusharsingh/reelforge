import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
  const audibleVideoId = randomUUID();
  const undersizedImageId = randomUUID();
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
          `color=c=${color}:s=1080x1920:d=0.2`,
          "-frames:v",
          "1",
          "-update",
          "1",
          join(root, key),
        ],
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      sources.set(key, await readFile(join(root, key)));
    }
    const audibleVideoPath = join(root, "audible-video.mp4");
    const audibleVideo = await runner.run({
      executable: "ffmpeg",
      argv: [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=navy:s=1080x1920:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=1",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        audibleVideoPath,
      ],
    });
    if (audibleVideo.exitCode !== 0) throw new Error(audibleVideo.stderr);
    sources.set("audible-video.mp4", await readFile(audibleVideoPath));
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
    sources.set("music.wav", await readFile(musicPath));
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
    sources.set("narration.wav", await readFile(wavPath));
    for (const [objectKey, body] of sources) {
      await storage.putObject({
        workspaceId,
        objectKey,
        body,
        contentType: objectKey.endsWith(".wav")
          ? "audio/wav"
          : objectKey.endsWith(".mp4")
            ? "video/mp4"
            : "image/png",
      });
    }
    assets = {
      getReference: async (
        _context: WorkspaceContext,
        request: { assetId: string; version: number },
      ) => {
        const isAudio = request.assetId === audioId;
        const objectKey =
          request.assetId === audibleVideoId
            ? "audible-video.mp4"
            : request.assetId === musicId
              ? "music.wav"
              : isAudio
                ? "narration.wav"
                : request.assetId === imageId
                  ? "source-0.png"
                  : request.assetId === undersizedImageId
                    ? "undersized.png"
                    : "source-1.png";
        const source = sources.get(objectKey)!;
        return {
          assetId: request.assetId,
          version: request.version,
          objectKey,
          checksumSha256: createHash("sha256").update(source).digest("hex"),
          byteSize: source.length,
          mediaType: isAudio
            ? "audio/wav"
            : request.assetId === audibleVideoId
              ? "video/mp4"
              : "image/png",
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
              r_frame_rate: "24/1",
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

  it("preserves audible source-video audio when there is no separate narration", async () => {
    const local = new CompositionEngine(runner, storage, assets);
    const artifacts = await local.execute(context, randomUUID(), {
      ...input,
      scenes: [
        {
          ...input.scenes[0]!,
          assetId: audibleVideoId,
          image: false,
          // Explicitly drop the fixture's narration refs: source audio must be
          // the only audible signal in this render.
          narrationAssetId: undefined,
          narrationAssetVersion: undefined,
        },
      ],
      coverFrames: [{ assetId: audibleVideoId, assetVersion: 1, timestampMs: 400 }],
    });
    const video = artifacts.find((artifact) => artifact.kind === "VIDEO")!;
    const outputPath = join(root, "audible-output.mp4");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, video.body));
    const volume = async (filter: string): Promise<number> => {
      const measured = await runner.run({
        executable: "ffmpeg",
        argv: ["-i", outputPath, "-af", filter, "-vn", "-sn", "-dn", "-f", "null", "/dev/null"],
      });
      if (measured.exitCode !== 0) throw new Error(measured.stderr);
      return Number(/max_volume: (-?[0-9.]+) dB/.exec(measured.stderr)?.[1]);
    };
    const maxVolume = await volume("volumedetect");
    const meanMeasured = await runner.run({
      executable: "ffmpeg",
      argv: [
        "-i",
        outputPath,
        "-af",
        "volumedetect",
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "null",
        "/dev/null",
      ],
    });
    if (meanMeasured.exitCode !== 0) throw new Error(meanMeasured.stderr);
    const meanVolume = Number(/mean_volume: (-?[0-9.]+) dB/.exec(meanMeasured.stderr)?.[1]);
    expect(Number.isFinite(maxVolume)).toBe(true);
    expect(Number.isFinite(meanVolume)).toBe(true);
    expect(maxVolume).toBeGreaterThan(-40);
    expect(meanVolume).toBeGreaterThan(-40);
    // The fixture tone is 880 Hz. Confirm the intended source signal is present
    // and the narration fixture's 440 Hz tone is not.
    expect(await volume("bandpass=f=880:width_type=h:w=50,volumedetect")).toBeGreaterThan(-40);
    // Cascade the bandpass to suppress the 880 Hz source's skirt leakage; a
    // genuine 440 Hz narration tone would still pass through at full level.
    const only440 =
      "bandpass=f=440:width_type=h:w=50,bandpass=f=440:width_type=h:w=50," +
      "bandpass=f=440:width_type=h:w=50,bandpass=f=440:width_type=h:w=50";
    expect(await volume(`${only440},volumedetect`)).toBeLessThan(-50);
    expect(
      (
        await runner.run({
          executable: "ffprobe",
          argv: ["-v", "error", "-show_streams", "-of", "json", outputPath],
        })
      ).stdout,
    ).toContain('"codec_name": "aac"');
  }, 120000);

  it.each([
    [1024, 1536],
    [720, 1280],
    [1080, 1920],
  ])(
    "normalizes %sx%s PNG to 1080x1920 at 24 fps",
    async (width, height) => {
      const sourcePath = join(root, `normalized-source-${width}.png`);
      const generated = await runner.run({
        executable: "ffmpeg",
        argv: [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=green:s=${width}x${height}`,
          "-frames:v",
          "1",
          sourcePath,
        ],
      });
      expect(generated.exitCode).toBe(0);
      const body = await readFile(sourcePath);
      sources.set("undersized.png", body);
      await storage.putObject({
        workspaceId,
        objectKey: "undersized.png",
        body,
        contentType: "image/png",
      });
      const engine = new CompositionEngine(runner, storage, assets);
      const artifacts = await engine.execute(context, randomUUID(), {
        ...input,
        scenes: [{ ...input.scenes[0]!, assetId: undersizedImageId, image: true }],
        coverFrames: [{ assetId: undersizedImageId, assetVersion: 1, timestampMs: 400 }],
      });
      const output = join(root, `normalized-${width}.mp4`);
      await writeFile(output, artifacts.find((item) => item.kind === "VIDEO")!.body);
      const report = await runner.run({
        executable: "ffprobe",
        argv: [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,r_frame_rate,codec_name",
          "-of",
          "json",
          output,
        ],
      });
      expect(JSON.parse(report.stdout).streams[0]).toMatchObject({
        width: 1080,
        height: 1920,
        r_frame_rate: "24/1",
        codec_name: "h264",
      });
    },
    120000,
  );

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
    expect(Math.abs(video.durationMs! - 1600)).toBeLessThanOrEqual(
      1000 / DEFAULT_RENDER_PROFILE.fps,
    );
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
      durationMs: video.durationMs,
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
