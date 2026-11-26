import { describe, expect, it } from "vitest";
import { captionMinimumTicks, captionPhrases, readableCaptionCues } from "./phrase-captions.js";

describe("phrase captions", () => {
  it("preserves the transcript and breaks on sentences and readable lengths", () => {
    const transcript =
      "The satellite carries a camera that helps scientists track storms. It also watches forests!";
    const phrases = captionPhrases(transcript);
    expect(phrases.join(" ")).toBe(transcript);
    expect(phrases.every((phrase) => phrase.length <= 36)).toBe(true);
    expect(phrases).not.toContainEqual(expect.stringContaining("storms. It"));
  });

  it("gives a fast cue enough reading time by using neighboring measured room", () => {
    const cues = [
      { text: "Look outside", start: 0.12, end: 1.3 },
      { text: "A brilliant morning", start: 1.4, end: 1.88 },
      { text: "Here comes the sun.", start: 2.01, end: 3.5 },
    ];
    const display = readableCaptionCues(
      cues,
      cues.map((cue) => cue.text),
      3.55,
    );
    expect(display.map((cue) => cue.text)).toEqual(cues.map((cue) => cue.text));
    expect(Math.round(display[1]!.end * 100) - Math.round(display[1]!.start * 100)).toBe(95);
    expect(display[0]!.end).toBeLessThanOrEqual(display[1]!.start);
    expect(display[1]!.end).toBeLessThanOrEqual(display[2]!.start);
    expect(display.every((cue) => cue.end <= 3.55)).toBe(true);
  });

  it("rejects pathological alignment instead of cramming phrases into a burst", () => {
    const cues = [
      { text: "Everything arrives at once", start: 16.95, end: 16.98 },
      { text: "Nobody can read this", start: 16.98, end: 17.0 },
      { text: "No spare speech time remains.", start: 17.0, end: 17.02 },
    ];
    expect(() =>
      readableCaptionCues(
        cues,
        cues.map((cue) => cue.text),
        17.04,
      ),
    ).toThrow("readable speed");
    expect(captionMinimumTicks("Go")).toBe(84);
  });
});
