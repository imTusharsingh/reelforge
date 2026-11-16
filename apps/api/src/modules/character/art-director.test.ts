import type { ReferenceLibrary } from "../reference-library/planning.ports.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ArtDirectorService } from "./art-director.service.js";
import { context, planningFixture, shotsFixture } from "../script/planning.fixture.js";
import type { ReferenceAsset, ChannelReferenceDefaults } from "@reelforge/contracts";
import type { PlanningPromptService } from "../config/planning-prompt.service.js";
import type { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import type { PlanningCharacterService } from "./planning-character.service.js";
import { pinPlanningShots } from "../script/planning-shots.js";
function fixture(): {
  service: ArtDirectorService;
  images: ReturnType<typeof vi.fn>;
  refs: ReferenceAsset[];
  library: ReferenceLibrary;
  generate: ReturnType<typeof vi.fn>;
} {
  const refs: ReferenceAsset[] = [];
  let defaults: ChannelReferenceDefaults | null = null;
  const library = {
    resolve: vi.fn(
      async (
        unused: unknown,
        pins: { referenceAssetId: string; version: number }[],
      ): Promise<ReferenceAsset[]> =>
        pins.map((pin) => {
          const ref = refs.find(
            (item) => item.referenceId === pin.referenceAssetId && item.version === pin.version,
          );
          if (!ref) throw new Error("Missing reference");
          return ref;
        }),
    ),
    defaults: vi.fn(async (): Promise<ChannelReferenceDefaults | null> => defaults),
    save: vi.fn(async (unused: unknown, ref: ReferenceAsset): Promise<void> => {
      refs.push(ref);
    }),
    setDefaults: vi.fn(async (unused: unknown, input: ChannelReferenceDefaults): Promise<void> => {
      defaults = input;
    }),
  };
  const generate = vi.fn().mockResolvedValue({
    character: {
      front: "Original owl front",
      side: "Original owl side",
      fullBody: "Original owl full body",
    },
    styleFrame: "Watercolor forest",
    keyframePrompts: Array(6).fill("Original watercolor leaves"),
  });
  const images = vi.fn().mockResolvedValue({ body: Buffer.from("image"), mediaType: "image/png" });
  const prompts = {
    capture: vi.fn().mockResolvedValue({ prompt: "instructions", receipt: { version: 2 } }),
  } as unknown as PlanningPromptService;
  const assets = {
    store: vi.fn(
      async (): Promise<{ assetId: string; version: number; checksumSha256: string }> => ({
        assetId: randomUUID(),
        version: 1,
        checksumSha256: "a".repeat(64),
      }),
    ),
  } as unknown as PlanningReferenceAssetsService;
  const characters = {
    publish: vi.fn().mockResolvedValue(randomUUID()),
  } as unknown as PlanningCharacterService;
  return {
    service: new ArtDirectorService(
      { generate },
      { generate: images },
      library,
      prompts,
      assets,
      characters,
    ),
    images,
    refs,
    library,
    generate,
  };
}
describe("V4 Art Director and reference reuse", () => {
  it("creates three character views and style once, then reuses unchanged pins", async () => {
    const f = fixture();
    const request = planningFixture();
    const first = await f.service.design(context, request, shotsFixture(request));
    expect(first.voiceId).toBe("narrator");
    expect(first.references.map((ref) => ref.kind)).toEqual([
      "CHARACTER",
      "CHARACTER",
      "CHARACTER",
      "STYLE",
    ]);
    expect(first.references.slice(0, 3).every((ref) => ref.characterVersionId)).toBe(true);
    expect(f.images).toHaveBeenCalledTimes(4);
    const next = { ...request, runId: randomUUID() };
    const second = await f.service.design(context, next, shotsFixture(next));
    expect(second.references).toEqual(first.references);
    expect(f.images).toHaveBeenCalledTimes(4);
    expect(second.shots.every((shot) => shot.references.length === 4)).toBe(true);
  });
  it("changing default character changes every shot without regeneration", async () => {
    const f = fixture();
    const request = planningFixture();
    await f.service.design(context, request, shotsFixture(request));
    const replacement = {
      ...f.refs[0]!,
      id: randomUUID(),
      referenceId: randomUUID(),
      version: 2,
      source: "PRESET" as const,
    };
    f.refs.push(replacement);
    const defaults = (await f.library.defaults(context, request.brief.channelId))!;
    defaults.character = [{ referenceAssetId: replacement.referenceId, version: 2 }];
    const shots = await pinPlanningShots(context, request, shotsFixture(request), f.library);
    expect(
      shots.every(
        (shot) =>
          shot.references[0]?.referenceAssetId === replacement.referenceId &&
          shot.references[0]?.version === 2,
      ),
    ).toBe(true);
    expect(f.images).toHaveBeenCalledTimes(4);
  });
  it("rejects invalid art and unsafe prompts before image spend", async () => {
    const f = fixture();
    const request = planningFixture();
    f.generate.mockResolvedValue({
      character: null,
      styleFrame: "Taylor Swift",
      keyframePrompts: Array(6).fill("frame"),
    });
    await expect(f.service.design(context, request, shotsFixture(request))).rejects.toThrow(
      "Real people",
    );
    expect(f.images).not.toHaveBeenCalled();
    f.generate.mockResolvedValue({
      character: null,
      styleFrame: "forest",
      keyframePrompts: ["frame"],
    });
    await expect(f.service.design(context, request, shotsFixture(request))).rejects.toThrow(
      "One keyframe",
    );
    expect(f.images).not.toHaveBeenCalled();
  });
  it("supports a narrator-only channel with a style reference", async () => {
    const f = fixture();
    const request = planningFixture();
    f.generate.mockResolvedValue({
      character: null,
      styleFrame: "forest",
      keyframePrompts: Array(6).fill("frame"),
    });
    const result = await f.service.design(context, request, shotsFixture(request));
    expect(result.references).toHaveLength(1);
    expect(f.images).toHaveBeenCalledTimes(1);
  });
});
