import {
  mergeCaptionText,
  captionMinimumTicks,
  captionPhrases,
  type AlignedWord,
} from "@reelforge/contracts";

// Captions are timed separately against the speech. They do not reuse word boundaries.
export type CaptionCue = Readonly<{ text: string; start: number; end: number }>;

export { captionMinimumTicks, captionPhrases };
export const minimumCue = 5; // Five ASS centiseconds span one 24 fps frame.
const tolerance = 60; // Choose display bounds up to 0.6s from measured speech.
const nominalBoundaryTolerance = 0.001;
export const captionTicks = (seconds: number): number => Math.round(seconds * 100);
const ticks = captionTicks;

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

type AnchoredCue = {
  cue: CaptionCue;
  firstEnd?: number;
  lastStart?: number;
};

function withWordAnchors(
  cues: readonly CaptionCue[],
  observed: readonly (AlignedWord | null)[] | undefined,
): AnchoredCue[] {
  if (!observed) return cues.map((cue) => ({ cue }));
  let offset = 0;
  const result = cues.map((cue) => {
    const words = cue.text.split(/\s+/u);
    const anchors = observed.slice(offset, offset + words.length).filter((word, i) => {
      if (!word) return false;
      if (word.text !== words[i])
        throw new Error("Caption phrases and measured words do not match");
      return true;
    });
    offset += words.length;
    return {
      cue,
      ...(anchors.length > 0 && {
        firstEnd: ticks(anchors[0]!.end),
        lastStart: ticks(anchors.at(-1)!.start),
      }),
    };
  });
  if (offset !== observed.length)
    throw new Error("Caption phrases do not cover the measured words");
  return result;
}

function timingLimits({ cue, firstEnd, lastStart }: AnchoredCue): {
  startMin: number;
  startMax: number;
  endMin: number;
  endMax: number;
  durationMin: number;
} {
  return {
    startMin: Math.max(0, ticks(cue.start) - tolerance),
    // Each measured anchor must overlap its whole-phrase window by at least one visible cue.
    startMax: Math.min(ticks(cue.start) + tolerance, (firstEnd ?? Infinity) - minimumCue),
    endMin: Math.max(ticks(cue.end) - tolerance, (lastStart ?? -Infinity) + minimumCue),
    endMax: ticks(cue.end) + tolerance,
    durationMin: captionMinimumTicks(cue.text),
  };
}

function fitCues(cues: readonly AnchoredCue[], duration: number): CaptionCue[] | null {
  const limits = cues.map(timingLimits);
  const latestStart = Array<number>(cues.length);
  const latestEnd = Array<number>(cues.length);
  let ceiling = duration;
  for (let i = cues.length - 1; i >= 0; i--) {
    const bound = limits[i]!;
    latestEnd[i] = Math.min(ceiling, bound.endMax);
    latestStart[i] = Math.min(bound.startMax, latestEnd[i]! - bound.durationMin);
    ceiling = latestStart[i]!;
    if (ceiling < bound.startMin || latestEnd[i]! < bound.endMin) return null;
  }
  let cursor = 0;
  const result: CaptionCue[] = [];
  for (const [i, { cue }] of cues.entries()) {
    const bound = limits[i]!;
    const start = Math.max(cursor, bound.startMin, Math.min(ticks(cue.start), latestStart[i]!));
    const end = Math.max(
      start + bound.durationMin,
      bound.endMin,
      Math.min(ticks(cue.end), latestEnd[i]!),
    );
    if (start > latestStart[i]! || end > latestEnd[i]!) return null;
    cursor = end;
    result.push({ text: cue.text, start: start / 100, end: end / 100 });
  }
  return result;
}

function mergeCue(left: AnchoredCue, right: AnchoredCue): AnchoredCue | null {
  if (ticks(right.cue.start) - ticks(left.cue.end) > tolerance) return null;
  const text = mergeCaptionText(left.cue.text, right.cue.text);
  if (!text) return null;
  const firstEnd = left.firstEnd ?? right.firstEnd;
  const lastStart = right.lastStart ?? left.lastStart;
  return {
    cue: { text, start: left.cue.start, end: right.cue.end },
    ...(firstEnd !== undefined && { firstEnd }),
    ...(lastStart !== undefined && { lastStart }),
  };
}

/** Fallback only when the natural phrase split is infeasible. For each prefix retain
 * the earliest feasible end, which gives all remaining phrases the most room. */
function mergeFeasibleCues(cues: readonly AnchoredCue[], duration: number): AnchoredCue[] {
  const best = new Map<number, { end: number; from: number; merged?: AnchoredCue }>();
  best.set(0, { end: 0, from: 0 });
  for (let start = 0; start < cues.length; start++) {
    const prefix = best.get(start);
    if (!prefix) continue;
    let merged: AnchoredCue | null = cues[start]!;
    for (let index = start; index < cues.length && merged; index++) {
      const bound = timingLimits(merged);
      const earliest = Math.max(prefix.end, bound.startMin);
      const end = Math.max(earliest + bound.durationMin, bound.endMin);
      if (
        earliest <= bound.startMax &&
        end <= Math.min(duration, bound.endMax) &&
        end < (best.get(index + 1)?.end ?? Infinity)
      )
        best.set(index + 1, { end, from: start, merged });
      if (index + 1 < cues.length) merged = mergeCue(merged, cues[index + 1]!);
    }
  }
  const result: AnchoredCue[] = [];
  for (let position = cues.length; position > 0;) {
    const choice = best.get(position);
    if (!choice?.merged) throw unreadable();
    result.push(choice.merged);
    position = choice.from;
  }
  return result.reverse();
}

export function readableCaptionCues(
  raw: readonly CaptionCue[],
  text: readonly string[],
  duration: number,
  observed?: readonly (AlignedWord | null)[],
): CaptionCue[] {
  if (!validPhraseTimeline(raw, text, duration))
    throw new Error("Phrase alignment does not match the measured narration");
  const cues = withWordAnchors(raw, observed);
  const ceiling = Math.floor(duration * 100);
  const fitted = fitCues(cues, ceiling) ?? fitCues(mergeFeasibleCues(cues, ceiling), ceiling);
  if (!fitted) throw unreadable();
  return fitted;
}

function unreadable(): Error {
  return new Error(
    "Captions cannot fit at a readable speed near the speech. Shorten the narration or use a slower pace.",
  );
}
