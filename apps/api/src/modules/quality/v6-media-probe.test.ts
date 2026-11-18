import { describe, expect, it, vi } from "vitest";
import type { SpawnProcessRunner } from "../composition/composition.engine.js";
import { V6MediaProbe } from "./v6-media-probe.js";

describe("V6 media inspection", () => {
  it("reads measured dimensions and detects black and frozen frames", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: 720, height: 1280, duration: "6.0" }],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "black_start:1 black_end:2 freeze_start:3",
      });
    const probe = new V6MediaProbe({ run } as unknown as SpawnProcessRunner);
    await expect(probe.inspect(Buffer.from("fixture"), 25)).resolves.toEqual({
      durationSeconds: 6,
      width: 720,
      height: 1280,
      hasBlackFrames: true,
      hasFrozenFrames: true,
      captionDriftMs: 25,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("fails closed for missing evidence and failed media inspection", async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "error" }));
    const probe = new V6MediaProbe({ run } as unknown as SpawnProcessRunner);
    await expect(probe.inspect(Buffer.alloc(0), 0)).rejects.toThrow("Media evidence missing");
    await expect(probe.inspect(Buffer.from("fixture"), Number.NaN)).rejects.toThrow(
      "Media evidence missing",
    );
    await expect(probe.inspect(Buffer.from("fixture"), 0)).rejects.toThrow(
      "Media inspection failed",
    );
  });
});
