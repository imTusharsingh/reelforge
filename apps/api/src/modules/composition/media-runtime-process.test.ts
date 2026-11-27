import { beforeEach, expect, it, vi } from "vitest";
import { createMediaRuntimeGate } from "./media-runtime.js";
import { mediaProbeEnv as env, readyProbeOutput } from "./media-runtime.fixture.js";

const execute = vi.hoisted(() =>
  vi.fn<(file: string, args: string[]) => Promise<{ stdout: Buffer }>>(),
);

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  // Node's execFile custom promisifier resolves stdout or rejects with the raw spawn error.
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async (file, args) => ({ stdout: readyProbeOutput(file, args) }));
});

it.each([
  [env.FFMPEG_PATH, "-filters"],
  [env.FFMPEG_PATH, "-filter_complex"],
  [env.FFPROBE_PATH, "-show_format"],
] as const)("classifies a raw %s %s spawn EAGAIN as retryable", async (binary, flag) => {
  const gate = createMediaRuntimeGate();
  await gate.activate(env);
  let unavailable = true;
  execute.mockImplementation(async (file, args) => {
    if (unavailable && file === binary && args.includes(flag))
      throw Object.assign(new Error("sensitive subprocess output"), {
        code: "EAGAIN",
        syscall: `spawn ${file}`,
      });
    return { stdout: readyProbeOutput(file, args) };
  });
  await expect(gate.prepareLanguage(() => "English", env)).rejects.toMatchObject({
    code: "LOCAL_RENDER_TRANSIENT",
    retryable: true,
    message: "Local media preflight was temporarily interrupted.",
  });
  unavailable = false;
  await expect(gate.prepareLanguage(() => "English", env)).resolves.toBeDefined();
});

it("keeps raw permanent spawn failures non-retryable without exposing subprocess output", async () => {
  execute.mockImplementation(async (file, args) => {
    if (file === env.FFMPEG_PATH)
      throw Object.assign(new Error("sensitive subprocess output"), {
        code: "ENOENT",
        syscall: `spawn ${file}`,
      });
    return { stdout: readyProbeOutput(file, args) };
  });
  await expect(createMediaRuntimeGate().activate(env)).rejects.toMatchObject({
    code: "MEDIA_TOOL_UNAVAILABLE",
    retryable: false,
    message: expect.stringContaining("FFmpeg with the subtitles filter"),
  });
});
