import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MediaReceipt } from "@reelforge/contracts";
import { describe, expect, it } from "vitest";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { SpawnProcessRunner } from "./composition.engine.js";
import { LocalWordAligner } from "./media-alignment.js";
import { captionMinimumTicks } from "./phrase-captions.js";
import { MediaRenderer } from "./media-render.js";

const transcript =
  "Imagine a tiny satellite circling the Earth every ninety minutes. From its window mountains look like wrinkles and rivers shine like ribbons. Each sunrise sweeps across the horizon in seconds. The satellite carries a camera that helps scientists track storms watch forests and learn how our planet changes over time.";

describe.skipIf(process.env.RF_ALIGNMENT_RENDER_TEST !== "1")("offline caption render", () => {
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
          "testsrc2=size=720x1280:rate=24:duration=10",
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
