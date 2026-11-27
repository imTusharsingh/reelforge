import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Inject, Injectable } from "@nestjs/common";
import { type AlignedWord, type MediaReceipt } from "@reelforge/contracts";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import { SpawnProcessRunner } from "./composition.engine.js";
import { LocalWordAligner, type WordAligner, type WordAlignment } from "./media-alignment.js";
import { highlightedCaptions } from "./highlighted-captions.js";
import type { CaptionCue } from "./phrase-captions.js";
import { assemblyArguments, type AssemblyClip } from "./media-filter.js";
type RenderMediaInput = {
  workspaceId: string;
  clips: { receipt: MediaReceipt; seconds: number; transition: string }[];
  narration: MediaReceipt;
  music: MediaReceipt;
  transcript: string;
  language: string;
  pace: number;
};
@Injectable()
export class MediaRenderer {
  public constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly runner: SpawnProcessRunner,
    @Inject(LocalWordAligner) private readonly aligner: WordAligner,
  ) {}
  public async render(input: RenderMediaInput): Promise<{
    video: Buffer;
    cover: Buffer;
    words: AlignedWord[];
    highlights: (AlignedWord | null)[];
    cues: CaptionCue[];
    duration: number;
  }> {
    const root = await mkdtemp(join(tmpdir(), "reelforge-v5-"));
    try {
      const seconds = input.clips.reduce((sum, clip) => sum + clip.seconds, 0);
      if (seconds < 30 || seconds > 45 || input.pace < 0.5 || input.pace > 2)
        throw new Error("Unsupported v2 duration or narration pace");
      const clips = await this.prepareClips(input, root);
      const rawVoice = join(root, "raw-voice"),
        narration = join(root, "narration.wav"),
        music = join(root, "music");
      await this.materialize(input.workspaceId, input.narration, rawVoice);
      await this.materialize(input.workspaceId, input.music, music);
      await this.call("ffmpeg", [
        "-nostdin",
        "-y",
        "-i",
        rawVoice,
        "-af",
        `atempo=${input.pace}`,
        "-t",
        String(seconds),
        "-ar",
        "16000",
        "-ac",
        "1",
        narration,
      ]);
      // The mix pads voice to the video duration later. Align only the paced speech:
      // trailing mix silence can collapse the last several words onto the final frame.
      const { words, highlights, cues } = await this.timings(narration, input, root, seconds);
      const captions = join(root, "captions.ass"),
        output = join(root, "final.mp4"),
        cover = join(root, "cover.jpg");
      await writeFile(captions, highlightedCaptions(cues, words, highlights));
      await this.call(
        "ffmpeg",
        assemblyArguments(clips, narration, music, captions, output, seconds),
      );
      await this.verify(output, seconds);
      await this.cover(output, cover);
      const bytes = await readFile(output),
        coverBytes = await readFile(cover);
      if (!bytes.length || !coverBytes.subarray(0, 2).equals(Buffer.from([255, 216])))
        throw new Error("Assembly outputs missing or invalid");
      return { video: bytes, cover: coverBytes, words, highlights, cues, duration: seconds };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  private async timings(
    path: string,
    input: RenderMediaInput,
    root: string,
    maximum: number,
  ): Promise<{ cues: CaptionCue[] } & WordAlignment> {
    const duration = Math.min(await this.narrationDuration(path), maximum);
    const cues = await this.aligner.alignPhrases(
      path,
      input.transcript,
      input.language,
      root,
      duration,
    );
    return {
      cues,
      ...(await this.aligner.alignMeasured(path, input.transcript, input.language, root, duration)),
    };
  }
  private async narrationDuration(path: string): Promise<number> {
    const audio = (await this.inspect(path)).find((stream) => stream.codec_type === "audio");
    const duration = Number(audio?.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Could not measure narration duration");
    return duration;
  }
  private async cover(output: string, cover: string): Promise<void> {
    await this.call("ffmpeg", [
      "-nostdin",
      "-y",
      "-ss",
      "1",
      "-i",
      output,
      "-frames:v",
      "1",
      "-update",
      "1",
      cover,
    ]);
  }
  private async prepareClips(input: RenderMediaInput, root: string): Promise<AssemblyClip[]> {
    const clips: AssemblyClip[] = [];
    for (const [index, clip] of input.clips.entries()) {
      const path = join(root, `clip-${index}.mp4`);
      await this.materialize(input.workspaceId, clip.receipt, path);
      const probe = await this.inspect(path);
      const video = probe.find((stream) => stream.codec_type === "video");
      if (
        !video ||
        Number(video.width) !== 720 ||
        Number(video.height) !== 1280 ||
        Number(video.duration) + 0.05 < clip.seconds
      )
        throw new Error("Expected a real 720p 9:16 clip covering the shot");
      clips.push({
        path,
        seconds: clip.seconds,
        audio: probe.some((stream) => stream.codec_type === "audio"),
        fade: /fade|crossfade/i.test(clip.transition),
      });
    }
    return clips;
  }
  private async materialize(
    workspaceId: string,
    receipt: MediaReceipt,
    path: string,
  ): Promise<void> {
    const bytes = await this.storage.getObject({ workspaceId, objectKey: receipt.objectKey });
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.checksumSha256)
      throw new Error("Pinned media checksum mismatch");
    await writeFile(path, bytes);
  }
  private async call(executable: "ffmpeg" | "ffprobe", argv: string[]): Promise<string> {
    const result = await this.runner.run({ executable, argv, signal: AbortSignal.timeout(300000) });
    if (result.exitCode)
      throw new Error("Local media process failed", {
        cause: new Error(result.stderr.slice(-3000)),
      });
    return result.stdout;
  }
  private async inspect(path: string): Promise<Record<string, unknown>[]> {
    const result: unknown = JSON.parse(
      await this.call("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]),
    );
    if (
      typeof result !== "object" ||
      result === null ||
      !("streams" in result) ||
      !Array.isArray(result.streams)
    )
      throw new Error("Invalid media inspection");
    return result.streams as Record<string, unknown>[];
  }
  private async verify(path: string, seconds: number): Promise<void> {
    const streams = await this.inspect(path),
      video = streams.find((s) => s.codec_type === "video"),
      audio = streams.find((s) => s.codec_type === "audio");
    if (
      !video ||
      !audio ||
      video.width !== 1080 ||
      video.height !== 1920 ||
      video.codec_name !== "h264" ||
      audio.codec_name !== "aac" ||
      !["24/1", "24"].includes(String(video.r_frame_rate)) ||
      Math.abs(Number(video.duration) - seconds) > 0.15
    )
      throw new Error("Assembly failed the locked technical profile", {
        cause: new Error(JSON.stringify({ video, audio })),
      });
  }
}
