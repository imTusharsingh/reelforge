import type { AlignedWord } from "@reelforge/contracts";
import {
  assCaptions,
  centis,
  minimumCue,
  safeCaptionText,
  type AssEvent,
} from "./media-alignment.js";
import type { CaptionCue } from "./phrase-captions.js";

// ASS color is BBGGRR; lime stands out from the default white and keeps the same outline.
const highlight = "{\\1c&H007AF4C4&}";
const clear = "{\\r}";

function phraseEvents(
  cue: CaptionCue,
  words: readonly AlignedWord[],
  observed: readonly (AlignedWord | null)[],
): AssEvent[] {
  const plain = words.map((word) => safeCaptionText(word.text));
  const neutral = plain.join(" ");
  const stop = centis(cue.end);
  let cursor = centis(cue.start);
  const events: AssEvent[] = [];
  const emit = (start: number, end: number, assText: string): void => {
    if (end > start) events.push({ start: start / 100, end: end / 100, assText });
  };
  observed.forEach((word, index) => {
    if (!word || word.text !== words[index]?.text) return;
    const start = Math.max(cursor, centis(word.start));
    const end = Math.min(stop, centis(word.end));
    if (end - start < minimumCue) return;
    const visible = plain.map((text, i) => (i === index ? highlight + text + clear : text));
    emit(cursor, start, neutral);
    emit(start, end, visible.join(" "));
    cursor = end;
  });
  emit(cursor, stop, neutral);
  return events;
}

export function highlightedCaptions(
  cues: readonly CaptionCue[],
  words: readonly AlignedWord[],
  observed: readonly (AlignedWord | null)[],
): string {
  let offset = 0;
  const events = cues.flatMap((cue) => {
    const count = cue.text.split(/\s+/u).length;
    const part = words.slice(offset, offset + count);
    if (part.map(({ text }) => text).join(" ") !== cue.text)
      throw new Error("Caption phrases and measured words do not match");
    const anchors = observed.slice(offset, offset + count);
    offset += count;
    return phraseEvents(cue, part, anchors);
  });
  if (offset !== words.length || observed.length !== words.length)
    throw new Error("Caption phrases do not cover the measured words");
  return assCaptions(events);
}
