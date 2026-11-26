// Captions are timed separately against the speech. They do not reuse word boundaries.
export type CaptionCue = Readonly<{ text: string; start: number; end: number }>;

const maxCharacters = 36;
const targetCharacters = 27;
const minFramesAt24Fps = 20;
const targetCharactersPerSecond = 20;
const tolerance = 60; // Choose display bounds up to 0.6s from measured speech.
const nominalBoundaryTolerance = 0.001;
const ticks = (seconds: number): number => Math.round(seconds * 100);
const characters = (text: string): number => Array.from(text).length;

export function captionPhrases(transcript: string): string[] {
  const words = transcript.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new Error("Narration transcript required");
  const result: string[] = [];
  let sentence: string[] = [];
  for (const word of words) {
    sentence.push(word);
    if (/[.!?…।！？。]["'’”)]*$/u.test(word)) {
      result.push(...splitSentence(sentence));
      sentence = [];
    }
  }
  return result.concat(splitSentence(sentence));
}

function splitSentence(words: readonly string[]): string[] {
  const length = words.length;
  const best = Array<number>(length + 1).fill(Infinity);
  const next = Array<number>(length);
  best[length] = 0;
  for (let i = length - 1; i >= 0; i--) {
    let size = 0;
    for (let j = i; j < length; j++) {
      size += characters(words[j]!) + Number(j > i);
      if (j > i && size > maxCharacters) break;
      const penalty = (targetCharacters - size) ** 2 + (size < 12 ? 180 : 0);
      const punctuation = /[,;:]["'’”)]*$/u.test(words[j]!) ? 28 : 0;
      const score = penalty - punctuation + best[j + 1]!;
      if (score < best[i]!) {
        next[i] = j + 1;
        best[i] = score;
      }
    }
  }
  const result: string[] = [];
  for (let i = 0; i < length; i = next[i]!) result.push(words.slice(i, next[i]).join(" "));
  return result;
}

export function captionMinimumTicks(text: string): number {
  return Math.max(
    Math.ceil((minFramesAt24Fps / 24) * 100),
    Math.ceil((characters(text) / targetCharactersPerSecond) * 100),
  );
}

function validPhraseTimeline(
  raw: readonly CaptionCue[],
  text: readonly string[],
  duration: number,
): boolean {
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    raw.length > 0 &&
    raw.length === text.length &&
    raw.every(
      (cue, i) =>
        cue.text === text[i] &&
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.start >= 0 &&
        cue.end > cue.start &&
        cue.end <= duration + nominalBoundaryTolerance &&
        (i === 0 || raw[i - 1]!.end <= cue.start),
    )
  );
}

export function readableCaptionCues(
  raw: readonly CaptionCue[],
  text: readonly string[],
  duration: number,
): CaptionCue[] {
  if (!validPhraseTimeline(raw, text, duration))
    throw new Error("Phrase alignment does not match the measured narration");
  const earliest = Array<number>(raw.length);
  const latestStart = Array<number>(raw.length);
  const latestEnd = Array<number>(raw.length);
  const min = text.map(captionMinimumTicks);
  let ceiling = Math.floor(duration * 100);
  for (let i = raw.length - 1; i >= 0; i--) {
    const cue = raw[i]!;
    latestEnd[i] = Math.min(ceiling, ticks(cue.end) + tolerance);
    latestStart[i] = Math.min(ticks(cue.start) + tolerance, latestEnd[i]! - min[i]!);
    earliest[i] = Math.max(0, ticks(cue.start) - tolerance);
    ceiling = latestStart[i]!;
    if (ceiling < earliest[i]!) throw unreadable();
  }
  let cursor = 0;
  return raw.map((cue, i) => {
    const start = Math.max(cursor, earliest[i]!, Math.min(ticks(cue.start), latestStart[i]!));
    const end = Math.max(start + min[i]!, Math.min(ticks(cue.end), latestEnd[i]!));
    if (start > latestStart[i]! || end > latestEnd[i]! || end < ticks(cue.end) - tolerance)
      throw unreadable();
    cursor = end;
    return { text: cue.text, start: start / 100, end: end / 100 };
  });
}

function unreadable(): Error {
  return new Error(
    "Captions cannot fit at a readable speed near the speech. Shorten the narration or use a slower pace.",
  );
}
