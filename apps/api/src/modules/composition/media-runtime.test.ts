import { describe, expect, it, vi } from "vitest";
import { createMediaRuntimeGate } from "./media-runtime.js";

const env = {
  ALIGNMENT_PYTHON_PATH: "/local/python",
  FFMPEG_PATH: "/local/ffmpeg",
  FFPROBE_PATH: "/local/ffprobe",
};
const readyOutput = (binary: string): Buffer => {
  if (binary === env.FFMPEG_PATH)
    return Buffer.from(" ... subtitles  V->V   Render text subtitles onto input video\n");
  if (binary === env.FFPROBE_PATH) return Buffer.from("ffprobe version fixture");
  if (binary === "espeak") return Buffer.concat([Buffer.from("RIFF1234WAVE"), Buffer.alloc(100)]);
  return Buffer.alloc(0);
};

describe("local media readiness", () => {
  it("probes local capabilities, caches success and blocks after a configuration change", async () => {
    const run = vi.fn(async (binary: string) => readyOutput(binary));
    const gate = createMediaRuntimeGate(run);
    await gate.activate(env);
    expect(run.mock.calls.map(([executable]) => executable)).toEqual([
      env.FFMPEG_PATH,
      env.FFPROBE_PATH,
      env.ALIGNMENT_PYTHON_PATH,
      "espeak",
    ]);
    gate.assertReady(env);
    expect(() => gate.assertReady({ ...env, FFMPEG_PATH: "/missing" })).toThrow("preflight");
    expect(run).toHaveBeenCalledTimes(4);
  });
  it.each([
    [env.FFMPEG_PATH, "FFmpeg with libass"],
    [env.FFPROBE_PATH, "Install FFprobe"],
    [env.ALIGNMENT_PYTHON_PATH, "Install aeneas"],
    ["espeak", "Install eSpeak"],
  ])("fails closed on a missing executable (%s)", async (missing, message) => {
    const gate = createMediaRuntimeGate(async (binary) => {
      if (binary === missing) throw new Error("sensitive child output must not be reflected");
      return readyOutput(binary);
    });
    await expect(gate.activate(env)).rejects.toThrow(message);
    expect(() => gate.assertReady(env)).toThrow("preflight");
  });
  it("rejects eSpeak that exits successfully without any reference audio", async () => {
    const gate = createMediaRuntimeGate(async (binary) =>
      binary === "espeak" ? Buffer.from("not audio") : readyOutput(binary),
    );
    await expect(gate.activate(env)).rejects.toThrow("voice data");
  });
});
