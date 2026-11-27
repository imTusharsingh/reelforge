import { expect, it } from "vitest";
import { highlightedCaptions } from "./highlighted-captions.js";

it("holds the whole phrase while changing only the measured word, without highlighting a repaired cue", () => {
  const words = [
    { text: "Hello", start: 0.2, end: 0.5 },
    { text: "little", start: 0.5, end: 0.7 },
    { text: "world", start: 0.7, end: 1 },
  ];
  const ass = highlightedCaptions([{ text: "Hello little world", start: 0, end: 1.2 }], words, [
    words[0]!,
    null,
    words[2]!,
  ])
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"));
  expect(ass).toHaveLength(5);
  expect(ass[0]).toContain("0:00:00.00,0:00:00.20,Default,,0,0,0,,Hello little world");
  expect(ass[1]).toContain("{\\1c&H007AF4C4&}Hello{\\r} little world");
  expect(ass[2]).toContain("0:00:00.50,0:00:00.70,Default,,0,0,0,,Hello little world");
  expect(ass[3]).toContain("Hello little {\\1c&H007AF4C4&}world{\\r}");
  expect(ass[4]).toContain("0:00:01.00,0:00:01.20,Default,,0,0,0,,Hello little world");
});

it("clips an anchor to the displayed phrase and escapes transcript ASS commands", () => {
  const word = { text: "Hi{\\r}", start: 0, end: 2 };
  const ass = highlightedCaptions([{ ...word, start: 0.5, end: 1.5 }], [word], [word]);
  expect(ass).toContain("0:00:00.50,0:00:01.50");
  expect(ass).toContain("Hi(＼r)");
});
