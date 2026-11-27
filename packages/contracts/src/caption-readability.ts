// Keep the planning bound and the timed renderer on the same caption units and limits.
const captionMaxCharacters = 36;
const captionCharactersPerSecond = 20;
const captionCharacters = (text: string): number => Array.from(text).length;
export const captionMinimumTicks = (text: string): number => minimumTicks(captionCharacters(text));

function minimumTicks(characters: number): number {
  return Math.max(
    Math.ceil((20 / 24) * 100),
    Math.ceil((characters / captionCharactersPerSecond) * 100),
  );
}

const targetCharacters = 27;

const titleAbbreviations =
  /^(?:dr|mr|mrs|ms|prof|sr|jr|st|rev|hon|gen|sgt|lt|capt|mt|vs|e\.g|i\.e)\.$/iu;
const initials = /^(?:\p{Lu}\.)+$/u;

function sentenceEnd(word: string): boolean {
  const clean = word.replace(/["'’”)\]]+$/u, "").replace(/^["'‘“(\[]+/u, "");
  return /[.!?…।！？。]$/u.test(clean) && !titleAbbreviations.test(clean) && !initials.test(clean);
}

export function captionPhrases(transcript: string): string[] {
  const words = transcript.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new Error("Narration transcript required");
  const result: string[] = [];
  let sentence: string[] = [];
  for (const word of words) {
    sentence.push(word);
    if (sentenceEnd(word)) {
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
      size += captionCharacters(words[j]!) + Number(j > i);
      if (j > i && size > captionMaxCharacters) break;
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

export function mergeCaptionText(left: string, right: string): string | null {
  const text = `${left} ${right}`;
  return captionCharacters(text) <= captionMaxCharacters ? text : null;
}

/** Minimum over the renderer's possible merges, ignoring measured anchor and gap restrictions. */
export function assertCaptionDuration(transcript: string, seconds: number): void {
  const phrases = captionPhrases(transcript);
  const best = Array<number>(phrases.length + 1).fill(Infinity);
  best[0] = 0;
  for (let start = 0; start < phrases.length; start++) {
    let merged: string | null = phrases[start]!;
    for (let end = start; end < phrases.length && merged; end++) {
      best[end + 1] = Math.min(best[end + 1]!, best[start]! + captionMinimumTicks(merged));
      merged = end + 1 < phrases.length ? mergeCaptionText(merged, phrases[end + 1]!) : null;
    }
  }
  if (best[phrases.length]! > Math.floor(seconds * 100))
    throw new Error("Script exceeds the readable caption duration; shorten the narration");
}
