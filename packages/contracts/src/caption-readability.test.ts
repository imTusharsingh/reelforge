import { expect, it } from "vitest";
import { assertCaptionDuration, captionPhrases } from "./caption-readability.js";

it("budgets over legal adjacent merges, not arbitrary divisions or unmerged phrases alone", () => {
  expect(captionPhrases("Go! Now!")).toEqual(["Go!", "Now!"]);
  expect(() => assertCaptionDuration("Go! Now!", 0.84)).not.toThrow();
  expect(() => assertCaptionDuration("Go! Now!", 0.83)).toThrow("readable caption duration");
});
