import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MediaReceipt } from "@reelforge/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { SpawnProcessRunner } from "./composition.engine.js";
import { LocalWordAligner } from "./media-alignment.js";
import { captionMinimumTicks } from "./phrase-captions.js";
import { mediaExecutable, mediaRuntimeGate } from "./media-runtime.js";
import { MediaRenderer } from "./media-render.js";

const transcript =
  "Imagine a tiny satellite circling the Earth every ninety minutes. From its window mountains look like wrinkles and rivers shine like ribbons. Each sunrise sweeps across the horizon in seconds. The satellite carries a camera that helps scientists track storms watch forests and learn how our planet changes over time.";

const bandWidth = 1080;
const bandHeight = 180;
async function captionPixels(
  video: string,
  time: number,
): Promise<{ white: number; lime: number; limeX: number }> {
  const { stdout } = await promisify(execFile)(
    mediaExecutable("ffmpeg"),
    [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      video,
      "-vf",
      `crop=${bandWidth}:${bandHeight}:0:1510`,
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 15000 },
  );
  expect(stdout.length).toBe(bandWidth * bandHeight * 3);
  let white = 0,
    lime = 0,
    xSum = 0;
  for (let i = 0; i < stdout.length; i += 3) {
    const r = stdout[i]!,
      g = stdout[i + 1]!,
      b = stdout[i + 2]!;
    if (r > 200 && g > 200 && b > 200) white++;
    if (g > 180 && g > r + 15 && r > 105 && b > 55 && b < 165) {
      lime++;
      xSum += (i / 3) % bandWidth;
    }
  }
  return { white, lime, limeX: lime ? xSum / lime : 0 };
}

async function assertCaptionFrames(
  filename: string,
  result: Awaited<ReturnType<MediaRenderer["render"]>>,
): Promise<void> {
  const first = result.cues[0]!;
  const visible = result.highlights.slice(0, first.text.split(" ").length).flatMap((word) => {
    if (!word) return [];
    const start = Math.max(word.start, first.start),
      end = Math.min(word.end, first.end);
    return end - start > 0.12 ? [(start + end) / 2] : [];
  });
  expect(visible.length).toBeGreaterThanOrEqual(2);
  const [left, right, after] = await Promise.all([
    captionPixels(filename, visible[0]!),
    captionPixels(filename, visible[1]!),
    captionPixels(filename, result.cues.at(-1)!.end + 0.25),
  ]);
  expect(left.white).toBeGreaterThan(200);
  expect(right.white).toBeGreaterThan(200);
  expect(left.lime).toBeGreaterThan(35);
  expect(right.lime).toBeGreaterThan(35);
  expect(right.limeX - left.limeX).toBeGreaterThan(20);
  expect(after).toEqual({ white: 0, lime: 0, limeX: 0 });
}

describe.skipIf(process.env.RF_ALIGNMENT_RENDER_TEST !== "1")("offline caption render", () => {
  beforeAll(async () => mediaRuntimeGate.activate(), 60000);

  it("aligns Italian through the exact locally admitted Aeneas/eSpeak voice", async () => {
    const root = await mkdtemp(join(tmpdir(), "caption-language-test-"));
    try {
      const voice = join(root, "italian.wav");
      const text = "Buongiorno mondo";
      const exec = promisify(execFile);
      await exec("espeak", ["-v", "it", "-w", voice, text]);
      const { stdout } = await exec(mediaExecutable("ffprobe"), [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        voice,
      ]);
      const duration = Number(stdout.trim());
      expect(mediaRuntimeGate.resolveLanguage("Italian")).toBe("ita");
      const aligner = new LocalWordAligner();
      const result = await aligner.alignMeasured(voice, text, "Italian", root, duration);
      expect(result.words.map((word) => word.text)).toEqual(text.split(" "));
      expect(result.highlights.filter(Boolean)).toHaveLength(2);
      expect(await aligner.alignPhrases(voice, text, "ita", root, duration)).toMatchObject([
        { text },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 35000);

  it.each([175, 115])(
    "renders readable phrase captions on the 30-second Short at %i wpm",
    async (speed) => {
      const root = await mkdtemp(join(tmpdir(), "caption-render-test-"));
      const exec = promisify(execFile);
      const runner = new SpawnProcessRunner();
      const ffmpeg = async (args: string[]): Promise<void> => {
        const result = await runner.run({
          executable: "ffmpeg",
          argv: ["-v", "error", "-y", ...args],
        });
        if (result.exitCode) throw new Error(result.stderr);
      };
      try {
        const clip = join(root, "clip.mp4");
        const voice = join(root, "voice.wav");
        const music = join(root, "music.wav");
        await ffmpeg([
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=720x1280:r=24:d=10",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          clip,
        ]);
        await exec("espeak", ["-v", "en", "-s", String(speed), "-w", voice, transcript]);
        await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=30", music]);
        const storage: StoragePort = {
          getObject: async ({ objectKey }) => readFile(join(root, objectKey)),
          putObject: () => Promise.reject(new Error("Writes to storage are not needed")),
          deleteObject: () => Promise.reject(new Error("Storage deletion is not needed")),
        };
        const receipt = async (
          path: string,
          mimeType: string,
          seconds: number,
        ): Promise<MediaReceipt> => ({
          key: path,
          providerId: "local-fixture",
          providerJobId: path,
          costMinor: 0,
          costBasis: "RESERVATION",
          modelId: "local-fixture",
          promptVersion: "test",
          objectKey: path,
          checksumSha256: createHash("sha256")
            .update(await readFile(join(root, path)))
            .digest("hex"),
          mimeType,
          seconds,
        });
        const clipReceipt = await receipt("clip.mp4", "video/mp4", 10);
        const result = await new MediaRenderer(storage, runner, new LocalWordAligner()).render({
          workspaceId: "offline-fixture",
          clips: Array.from({ length: 3 }, () => ({
            receipt: clipReceipt,
            seconds: 10,
            transition: "cut",
          })),
          narration: await receipt("voice.wav", "audio/wav", 18),
          music: await receipt("music.wav", "audio/wav", 30),
          transcript,
          language: "English",
          pace: 1,
        });
        expect(result.duration).toBe(30);
        expect(result.video.length).toBeGreaterThan(0);
        expect(result.words.map((word) => word.text)).toEqual(transcript.split(" "));
        expect(result.cues.map((cue) => cue.text).join(" ")).toBe(transcript);
        expect(result.cues.length).toBeLessThan(20);
        expect(result.cues.at(-1)?.end).toBeLessThan(speed === 175 ? 19 : 28);
        for (const [index, cue] of result.cues.entries()) {
          expect(Math.round(cue.end * 100) - Math.round(cue.start * 100)).toBeGreaterThanOrEqual(
            captionMinimumTicks(cue.text),
          );
          if (index) expect(cue.start).toBeGreaterThanOrEqual(result.cues[index - 1]!.end);
        }
        const rendered = join(root, "rendered.mp4");
        await writeFile(rendered, result.video);
        await assertCaptionFrames(rendered, result);
        if (speed === 175 && process.env.RF_ALIGNMENT_OUTPUT) {
          await writeFile(process.env.RF_ALIGNMENT_OUTPUT, result.video, { flag: "wx" });
          await writeFile(
            `${process.env.RF_ALIGNMENT_OUTPUT}.json`,
            JSON.stringify(result.cues, null, 2),
            { flag: "wx" },
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
