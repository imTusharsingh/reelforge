import { describe, expect, it } from "vitest";
import { reservationCents, secondsCost } from "@reelforge/ai-providers";
import {
  clipMoney,
  imageSurcharge,
  mediaCatalog,
  plannedRunOverheadCents,
} from "./media-prices.js";
describe("V5 prices use the landed V2 catalog and image-count estimator", () => {
  it("uses current catalog rates and one reservation rounding per paid clip", () => {
    const primary = mediaCatalog().find(
      (row) => row.kind === "VIDEO" && row.providerId === "gemini",
    )!;
    expect(clipMoney({ durationSeconds: 8 }, false)).toEqual(
      secondsCost(8, primary.pricePerSecond["720p"]!),
    );
    expect(reservationCents(clipMoney({ durationSeconds: 8 }, false))).toBe(56);
    expect(
      plannedRunOverheadCents(Array.from({ length: 6 }, () => ({ durationSeconds: 7.5 }))),
    ).toBe(102);
  });
  it("charges Grok per input image, including pinned first/last frames, never a flat shot fee", () => {
    const reference = { referenceAssetId: mediaCatalog()[0]!.id, version: 1 };
    const cap = mediaCatalog().find((row) => row.kind === "VIDEO" && row.providerId === "xai")!;
    const noFrames = secondsCost(6, cap.pricePerSecond["720p"]!);
    const one = clipMoney({ durationSeconds: 6, references: [] }, true);
    const many = clipMoney(
      {
        durationSeconds: 6,
        references: [reference, reference],
        firstFrameFrom: { previousShotOrdinal: 0 },
      },
      true,
    );
    expect(one.microUsd - noFrames.microUsd).toBe(imageSurcharge());
    expect(many.microUsd - noFrames.microUsd).toBe(4 * imageSurcharge());
  });
});
