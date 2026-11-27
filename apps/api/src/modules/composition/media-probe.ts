import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assemblyOutputArguments, type AssemblyClip } from "./media-filter.js";

const clip = (audio: boolean, fade: boolean): AssemblyClip => ({
  path: "",
  seconds: 0.25,
  audio,
  fade,
});
const video = "color=c=black:s=64x112:r=24";
const audio = "sine=frequency=440:sample_rate=48000";
const fixture = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:00.75,Default,,0,0,0,,ReelForge
`;
const inspection = z.object({
  format: z.object({ format_name: z.string() }),
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
});

export async function verifyAssemblyRoundTrip(
  run: (executable: string, args: string[]) => Promise<Buffer>,
  ffmpeg: string,
  ffprobe: string,
): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "reelforge-media-probe-"));
  try {
    const captions = join(root, "captions.ass");
    const output = join(root, "probe.mp4");
    await writeFile(captions, fixture);
    const inputs = [video, video, `${video}[out0];${audio}[out1]`, audio, audio];
    const args = assemblyOutputArguments(
      [clip(false, true), clip(false, false), clip(true, false)],
      captions,
      output,
      0.75,
    );
    args.splice(-1, 0, "-threads:v", "2");
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...inputs.flatMap((input) => ["-f", "lavfi", "-i", input]),
      ...args,
    ]);
    const checked = inspection.parse(
      JSON.parse(
        (
          await run(ffprobe, [
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            output,
          ])
        ).toString(),
      ),
    );
    return (
      checked.format.format_name.split(",").includes("mp4") &&
      checked.streams.some(
        (stream) =>
          stream.codec_type === "video" &&
          stream.codec_name === "h264" &&
          stream.width === 1080 &&
          stream.height === 1920,
      ) &&
      checked.streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
