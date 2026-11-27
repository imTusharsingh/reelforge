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

  it("does not treat honorifics or names with initials as sentence breaks", () => {
    const transcript = "Dr. Li met Dr. Wu.";
    const phrases = captionPhrases(transcript);
    expect(phrases).toEqual([transcript]);
    expect(readableCaptionCues([{ text: transcript, start: 0, end: 1.81 }], phrases, 1.81)).toEqual(
      [{ text: transcript, start: 0, end: 1.81 }],
    );
    expect(captionPhrases("J. R. Li and Prof. Wu met. They waved.")).not.toContain("J.");
  });

  it("merges adjacent measurements when a hard punctuation split cannot fit", () => {
    const transcript = "Adm. Li met Adm. Wu.";
    const phrases = captionPhrases(transcript);
    expect(phrases).toEqual(["Adm.", "Li met Adm.", "Wu."]);
    const bounds = [0, 0.36, 1.29, 1.81];
    const measured = phrases.map((text, index) => ({
      text,
      start: bounds[index]!,
      end: bounds[index + 1]!,
    }));
    expect(readableCaptionCues(measured, phrases, 1.81)).toEqual([
      { text: transcript, start: 0, end: 1.81 },
    ]);
  });

  it("fits an adjusted phrase around the measured word even near its leading edge", () => {
    const words = [
      { text: "One", start: 1.0, end: 1.2 },
      { text: "word", start: 1.49, end: 2.03 },
    ];
    const result = readableCaptionCues(
      [{ text: "One word", start: 1.18, end: 2.2 }],
      ["One word"],
      2.2,
      words,
    );
    expect(result).toEqual([{ text: "One word", start: 1.15, end: 2.2 }]);
  });

  it("rejects measurable words too far from the phrase rather than dropping them", () => {
    expect(() =>
      readableCaptionCues([{ text: "One", start: 1.9, end: 2.75 }], ["One"], 2.75, [
        { text: "One", start: 1.0, end: 1.2 },
      ]),
    ).toThrow("readable speed");
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
