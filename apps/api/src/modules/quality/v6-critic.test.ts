import { describe, expect, it, vi } from "vitest";
import {
  boundedRedo,
  critique,
  noveltyScore,
  multimodalRubric,
  type CriticClip,
} from "./v6-critic.js";
import { packageShort } from "./v6-packaging.js";
import { V6QualityPipeline } from "./v6-quality.pipeline.js";
import type { TextPort, TextSpec } from "@reelforge/ai-providers";

const good: CriticClip = {
  id: "shot-1",
  probe: {
    durationSeconds: 6,
    width: 1080,
    height: 1920,
    hasBlackFrames: false,
    hasFrozenFrames: false,
    captionDriftMs: 0,
  },
  hookText: "hook",
  narrativeText: "ocean story",
  visualDescription: "ocean",
  captionText: "ocean",
};
const rubric = {
  hook: 8,
  coherence: 8,
  artifacts: 8,
  captionSync: 8,
  briefFit: 8,
  policy: 8,
} as const;

describe("V6 critic and packaging", () => {
  it("hard-gates black frames and cannot be overridden by a score", () => {
    const result = critique(
      [{ ...good, probe: { ...good.probe, hasBlackFrames: true } }],
      { requiredTerms: ["ocean"], bannedTerms: [] },
      rubric,
    );
    expect(result.score).toBe(8);
    expect(result.passed).toBe(false);
  });
  it("catches caption drift and off-brief fixtures", () => {
    const result = critique(
      [
        {
          ...good,
          narrativeText: "mountain",
          visualDescription: "mountain",
          probe: { ...good.probe, captionDriftMs: 300 },
        },
      ],
      { requiredTerms: ["ocean"], bannedTerms: [] },
      rubric,
    );
    expect(result.hardGates[0]?.reasons).toContain("caption drift");
    expect(result.rubric.briefFit).toBe(0);
  });
  it("bounds redo calls and packaging fields", async () => {
    const reshoot = vi.fn(async () => undefined);
    const reedit = vi.fn(async () => undefined);
    await boundedRedo(
      critique(
        [{ ...good, probe: { ...good.probe, hasFrozenFrames: true } }],
        { requiredTerms: [], bannedTerms: [] },
        rubric,
      ),
      { reshoot, reedit, remainingCents: 800 },
    );
    expect(reshoot).toHaveBeenCalledTimes(1);
    expect(
      packageShort({
        title: "x".repeat(120),
        description: "d",
        tags: ["a", "a"],
        coverFrameTimestampMs: 0,
      }),
    ).toMatchObject({ title: "x".repeat(100), containsSyntheticMedia: true, tags: ["a"] });
  });
  it("uses the V2 multimodal text port and checks channel novelty", async () => {
    const text: TextPort = {
      complete: async <T>(spec: TextSpec<T>) => ({
        output: spec.parse(rubric),
        providerJobId: "fixture",
        usage: {},
      }),
    };
    await expect(
      multimodalRubric(text, {
        prompt: "review",
        media: [{ type: "video", mime_type: "video/mp4", uri: "fixture://clip" }],
        correlationId: "run",
      }),
    ).resolves.toEqual(rubric);
    expect(
      noveltyScore({ title: "Ocean facts", angle: "waves" }, [
        { title: "Ocean facts", angle: "waves" },
      ]),
    ).toBe(0);
  });
  it("runs the complete gated V6 pipeline", async () => {
    const text: TextPort = {
      complete: async <T>(spec: TextSpec<T>) => ({
        output: spec.parse(rubric),
        providerJobId: "fixture",
        usage: {},
      }),
    };
    const reshoot = vi.fn(async () => undefined);
    const result = await new V6QualityPipeline().review(
      {
        enabled: true,
        clips: [good],
        brief: { requiredTerms: ["ocean"], bannedTerms: [] },
        critic: { prompt: "review", media: [], correlationId: "run" },
        redo: { reshoot, reedit: vi.fn(async () => undefined), remainingCents: 800 },
        package: {
          title: "Ocean",
          description: "A short",
          tags: ["ocean"],
          coverFrameTimestampMs: 0,
        },
        novelty: { title: "Ocean", angle: "waves" },
      },
      text,
    );
    expect(result).toMatchObject({
      criticPassed: true,
      noveltyScore: 10,
      packaging: { containsSyntheticMedia: true },
    });
    expect(reshoot).not.toHaveBeenCalled();
  });
});
