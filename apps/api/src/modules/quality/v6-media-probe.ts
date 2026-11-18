import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
import type { ClipProbe } from "./v6-critic.js";

const probeResult = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        duration: z.coerce.number().positive().optional(),
      }),
    )
    .min(1),
  format: z.object({ duration: z.coerce.number().positive().optional() }).optional(),
});

/** Inspects bytes retrieved and checksum-verified by the caller. Caption drift needs independent evidence. */
@Injectable()
export class V6MediaProbe {
  public constructor(private readonly runner: SpawnProcessRunner) {}

  public async inspect(bytes: Buffer, captionDriftMs: number): Promise<ClipProbe> {
    if (!bytes.length || !Number.isFinite(captionDriftMs))
      throw new Error("Media evidence missing");
    const root = await mkdtemp(join(tmpdir(), "reelforge-critic-"));
    const path = join(root, "clip.mp4");
    try {
      await writeFile(path, bytes);
      const probe = await this.run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,duration:format=duration",
        "-of",
        "json",
        path,
      ]);
      const parsed = probeResult.parse(JSON.parse(probe.stdout) as unknown);
      const video = parsed.streams.find((stream) => stream.codec_type === "video");
      const durationSeconds = video?.duration ?? parsed.format?.duration;
      if (!video?.width || !video.height || !durationSeconds)
        throw new Error("Video stream metadata missing");
      const diagnostics = await this.run("ffmpeg", [
        "-nostdin",
        "-hide_banner",
        "-i",
        path,
        "-vf",
        "blackdetect=d=0:pix_th=0.10,freezedetect=n=-60dB:d=0.5",
        "-an",
        "-f",
        "null",
        "-",
      ]);
      return {
        durationSeconds,
        width: video.width,
        height: video.height,
        hasBlackFrames: /black_start:/.test(diagnostics.stderr),
        hasFrozenFrames: /freeze_start:/.test(diagnostics.stderr),
        captionDriftMs,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async run(
    executable: "ffmpeg" | "ffprobe",
    argv: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.runner.run({ executable, argv, signal: AbortSignal.timeout(300000) });
    if (result.exitCode !== 0) throw new Error(`Media inspection failed: ${executable}`);
    return result;
  }
}
