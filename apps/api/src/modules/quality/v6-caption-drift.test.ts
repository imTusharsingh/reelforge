import { describe, expect, it } from "vitest";
import { wordCaptions } from "../composition/media-alignment.js";
import { captionDriftMs } from "./v6-caption-drift.js";

describe("caption alignment evidence", () => {
  const words = [{ text: "Hello", start: 0.104, end: 0.906 }];
  it("measures timing against the actual rendered subtitle input", () => {
    expect(captionDriftMs(words, wordCaptions(words))).toBeCloseTo(4);
    expect(
      captionDriftMs(words, wordCaptions(words).replace("0:00:00.10", "0:00:00.40")),
    ).toBeCloseTo(296);
  });
  it("rejects missing, malformed, and mismatched evidence", () => {
    expect(() => captionDriftMs(words, "")).toThrow("Caption count");
    expect(() => captionDriftMs(words, wordCaptions(words).replace("Hello", "Other"))).toThrow(
      "Caption text",
    );
    expect(() =>
      captionDriftMs(words, wordCaptions(words).replace("0:00:00.10", "invalid")),
    ).toThrow("timestamp");
  });
});
