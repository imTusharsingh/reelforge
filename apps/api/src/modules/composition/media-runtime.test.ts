import { describe, expect, it, vi } from "vitest";
import { createMediaRuntimeGate } from "./media-runtime.js";

import { mediaProbeEnv as env, readyProbeOutput as readyOutput } from "./media-runtime.fixture.js";

describe("local media readiness", () => {
  it("probes local capabilities, caches success and blocks after a configuration change", async () => {
    const run = vi.fn(async (binary: string, args: string[]) => readyOutput(binary, args));
    const gate = createMediaRuntimeGate(run);
    await gate.activate(env);
    expect(run.mock.calls.map(([executable]) => executable)).toEqual([
      env.FFMPEG_PATH,
      env.FFPROBE_PATH,
      env.FFMPEG_PATH,
      env.FFPROBE_PATH,
      env.ALIGNMENT_PYTHON_PATH,
      "espeak",
    ]);
    gate.assertReady(env);
    expect(() => gate.assertReady({ ...env, FFMPEG_PATH: "/missing" })).toThrow("preflight");
    expect(run).toHaveBeenCalledTimes(6);
  });
  it.each([
    [env.FFMPEG_PATH, "FFmpeg with libass"],
    [env.FFPROBE_PATH, "Install FFprobe"],
    [env.ALIGNMENT_PYTHON_PATH, "Install aeneas"],
    ["espeak", "Install eSpeak"],
  ])("fails closed on a missing executable (%s)", async (missing, message) => {
    const gate = createMediaRuntimeGate(async (binary, args) => {
      if (binary === missing) throw new Error("sensitive child output must not be reflected");
      return readyOutput(binary, args);
    });
    await expect(gate.activate(env)).rejects.toThrow(message);
    expect(() => gate.assertReady(env)).toThrow("preflight");
  });
  it("admits Italian aliases only when both Aeneas and the installed eSpeak voice work", async () => {
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === env.ALIGNMENT_PYTHON_PATH)
        return Buffer.from('{"eng":"en","ita":"it","spa":"es","fra":"fr"}');
      if (binary === "espeak" && args[1] === "es") throw new Error("No Spanish voice");
      if (binary === "espeak" && args[1] === "fr") return Buffer.from("not audio");
      return readyOutput(binary, args);
    });
    const gate = createMediaRuntimeGate(run);
    await gate.activate(env);
    for (const input of ["Italian", " ita ", "IT"]) {
      expect(gate.resolveLanguage(input, env)).toBe("ita");
      expect(() => gate.assertLanguage(() => input, env)).not.toThrow();
    }
    for (const input of ["Spanish", "French", "zzz", "unsupported free text"]) {
      expect(() => gate.resolveLanguage(input, env)).toThrow("cannot be aligned locally");
      expect(() => gate.assertLanguage(() => input, env)).toThrow("cannot be aligned locally");
    }
    expect(run).toHaveBeenCalledTimes(9);
  });

  it("rechecks current tools and only the pinned voice before each paid boundary", async () => {
    let missing: string | undefined;
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (missing === binary || (binary === "espeak" && args[1] === missing))
        throw new Error("tool removed at the same path");
      if (binary === env.ALIGNMENT_PYTHON_PATH)
        return Buffer.from('{"eng":"en","ita":"it","spa":"es"}');
      return readyOutput(binary, args);
    });
    const gate = createMediaRuntimeGate(run);
    await gate.activate(env);
    run.mockClear();
    const evidence = await gate.prepareLanguage(() => "Italian", env);
    expect(
      run.mock.calls.filter(([binary]) => binary === "espeak").map(([, args]) => args[1]),
    ).toEqual(["it"]);
    expect(
      run.mock.calls.find(([binary]) => binary === env.ALIGNMENT_PYTHON_PATH)?.[1].slice(-2),
    ).toEqual(["ita", "it"]);
    expect(() => gate.assertFreshLanguage(() => "ita", evidence, env)).not.toThrow();
    expect(() => gate.assertFreshLanguage(() => "Spanish", evidence, env)).toThrow(
      "missing or expired",
    );
    expect(() => gate.assertFreshLanguage(() => "Italian", undefined, env)).toThrow(
      "missing or expired",
    );
    expect(() =>
      gate.assertFreshLanguage(
        () => "Italian",
        evidence && { ...evidence, checkedAt: performance.now() - 20000 },
        env,
      ),
    ).toThrow("missing or expired");

    for (const [dependency, label] of [
      [env.ALIGNMENT_PYTHON_PATH, "aeneas"],
      [env.FFMPEG_PATH, "FFmpeg"],
      [env.FFPROBE_PATH, "FFprobe"],
      ["it", "eSpeak narration voice"],
    ] as const) {
      missing = dependency;
      await expect(gate.prepareLanguage(() => "Italian", env)).rejects.toThrow(label);
      // The old, configured path did not change; the new subprocess itself detected the loss.
      expect(gate.resolveLanguage("Italian", env)).toBe("ita");
    }
  });

  it("rejects eSpeak that exits successfully without any reference audio", async () => {
    const gate = createMediaRuntimeGate(async (binary, args) =>
      binary === "espeak" ? Buffer.from("not audio") : readyOutput(binary, args),
    );
    await expect(gate.activate(env)).rejects.toThrow("voice data");
  });
});

it.each(["libx264", "aac"])(
  "fails before paid work when %s stops encoding at the same path",
  async (encoder) => {
    let available = true;
    const gate = createMediaRuntimeGate(async (binary, args) => {
      if (!available && binary === env.FFMPEG_PATH && args.includes(encoder))
        throw new Error("secret raw subprocess details");
      return readyOutput(binary, args);
    });
    await gate.activate(env);
    await expect(gate.prepareLanguage(() => "English", env)).resolves.toBeDefined();
    available = false;
    await expect(gate.prepareLanguage(() => "English", env)).rejects.toThrow(
      "MP4 encode and inspection",
    );
    await expect(gate.activate(env)).rejects.toThrow("MP4 encode and inspection");
  },
);

it("rejects a probe that executes but reports the wrong MP4 streams", async () => {
  const gate = createMediaRuntimeGate(async (binary, args) =>
    args.includes("-show_format")
      ? Buffer.from('{"format":{"format_name":"mp4"},"streams":[]}')
      : readyOutput(binary, args),
  );
  await expect(gate.activate(env)).rejects.toThrow("MP4 encode and inspection");
});
