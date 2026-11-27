// Keep the planning bound and the timed renderer on the same caption units and limits.
export const captionMaxCharacters = 36;
export const captionCharactersPerSecond = 20;
export const captionCharacters = (text: string): number => Array.from(text).length;
export const captionMinimumTicks = (text: string): number => minimumTicks(captionCharacters(text));

function minimumTicks(characters: number): number {
  return Math.max(
    Math.ceil((20 / 24) * 100),
    Math.ceil((characters / captionCharactersPerSecond) * 100),
  );
}

/** Best possible partition, without speech anchors or gaps. A fit is necessary, not sufficient. */
export function assertCaptionDuration(transcript: string, seconds: number): void {
  const words = transcript.trim().split(/\s+/u).map(captionCharacters);
  const best = Array<number>(words.length + 1).fill(Infinity);
  best[0] = 0;
  for (let start = 0; start < words.length; start++) {
    let length = 0;
    for (let end = start; end < words.length; end++) {
      length += words[end]! + Number(start !== end);
      // Like the renderer, allow a single long token that cannot be split.
      if (end !== start && length > captionMaxCharacters) break;
      best[end + 1] = Math.min(best[end + 1]!, best[start]! + minimumTicks(length));
    }
  }
  if (best[words.length]! > Math.floor(seconds * 100))
    throw new Error("Script exceeds the readable caption duration; shorten the narration");
}
