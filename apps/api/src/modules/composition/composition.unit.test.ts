import { describe, expect, it, vi } from "vitest";
import { SpawnProcessRunner } from "./composition.engine.js";

describe("CompositionValidation", () => {
  it("rejects a cover asset that does not belong to its timestamp scene", async () => {
    const { parse, createRenderSchema, validateComposition } =
      await import("./composition.validation.js");
    const { DEFAULT_RENDER_PROFILE } = await import("@reelforge/media");
    const input = {
      schemaVersion: "1.0" as const,
      title: "Cover membership",
      profile: DEFAULT_RENDER_PROFILE,
      sourceMediaPackage: {
        jobId: crypto.randomUUID(),
        scriptId: crypto.randomUUID(),
        scriptRevision: 1,
        schemaVersion: "1.0" as const,
      },
      scenes: [0, 1].map((index) => ({
        sceneId: String(index),
        assetId: crypto.randomUUID(),
        assetVersion: 1,
        image: true,
        durationMs: 1000,
        captions: [],
      })),
      audio: [],
      coverFrames: [{ assetId: crypto.randomUUID(), assetVersion: 1, timestampMs: 500 }],
      renderSeed: "unit-test-seed",
    };
    const parsed = parse(createRenderSchema, { idempotencyKey: "cover", input });
    expect(() =>
      validateComposition({
        ...parsed.input,
        coverFrames: [
          { assetId: parsed.input.coverFrames[0]!.assetId, assetVersion: 1, timestampMs: 500 },
        ],
      }),
    ).toThrow(/compose/i);
  });
});

describe.skipIf(process.env.FFPROBE_PATH === undefined)("SpawnProcessRunner", () => {
  it("removes its abort listener after success using argv arrays", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const runner = new SpawnProcessRunner();
    try {
      await expect(
        runner.run({ executable: "ffprobe", argv: ["-version"], signal: controller.signal }),
      ).resolves.toMatchObject({ exitCode: 0 });
      const listener = add.mock.calls[0]?.[1];
      expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(remove).toHaveBeenCalledWith("abort", listener);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
