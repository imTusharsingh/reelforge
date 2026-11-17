import {
  DiscoveryFactors,
  type ChannelBrief,
  type LearnedChange,
  type LearningState,
} from "@reelforge/contracts";
import type { LearningSample } from "../idea/discovery/types.js";

export const WEEKLY_MAX_DELTA = 0.05;
export function learningWeek(now: Date): string {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
// Transfers preserve sum=1 and each bound. One audit/ISO week caps cumulative drift.
function tune(
  current: Record<string, number>,
  signals: Record<string, number>,
  bounds: Record<string, { min: number; max: number }> | undefined,
): Record<string, number> | null {
  if (
    !bounds ||
    Object.keys(current).some(
      (key) => !bounds[key] || current[key]! < bounds[key]!.min || current[key]! > bounds[key]!.max,
    )
  )
    return null;
  const keys = Object.keys(current).sort((a, b) => (signals[b] ?? 0) - (signals[a] ?? 0));
  const best = keys[0],
    worst = keys.at(-1);
  if (!best || !worst || best === worst || (signals[best] ?? 0) <= (signals[worst] ?? 0))
    return { ...current };
  const delta = Math.max(
    0,
    Math.min(
      WEEKLY_MAX_DELTA,
      bounds[best]!.max - current[best]!,
      current[worst]! - bounds[worst]!.min,
    ),
  );
  return { ...current, [best]: current[best]! + delta, [worst]: current[worst]! - delta };
}
export function proposeLearning(
  brief: ChannelBrief,
  before: LearningState,
  samples: readonly LearningSample[],
  now: Date,
  id: string,
): LearnedChange {
  const unique = [...new Map(samples.map((sample) => [sample.videoId, sample])).values()];
  const base = {
    id,
    createdAt: now.toISOString(),
    week: learningWeek(now),
    before,
    evidenceSnapshotIds: [...new Set(unique.flatMap((row) => row.evidenceSnapshotIds))],
  };
  if (unique.length < 3)
    return {
      ...base,
      mode: "INSUFFICIENT_DATA",
      reason: "At least three joined Shorts with complete retention evidence are required.",
      after: before,
    };
  const mean = unique.reduce((sum, sample) => sum + sample.retention, 0) / unique.length;
  const signals = Object.fromEntries(
    DiscoveryFactors.map((key) => [
      key,
      unique.reduce((sum, sample) => sum + sample.factors[key] * (sample.retention - mean), 0),
    ]),
  );
  const formats = Object.fromEntries(
    Object.keys(before.formatMix).map((key) => {
      const rows = unique.filter((sample) => sample.formatKey === key);
      return [
        key,
        rows.length
          ? rows.reduce((sum, sample) => sum + sample.retention, 0) / rows.length - mean
          : 0,
      ];
    }),
  );
  const weights = tune(before.weights, signals, brief.tuningBounds?.scoringWeights);
  const formatMix = tune(before.formatMix, formats, brief.tuningBounds?.formatMix);
  if (!weights || !formatMix)
    return {
      ...base,
      mode: "RECOMMENDATION",
      reason:
        "Configure valid scoring and format bounds before applying learning. Prompt/config changes remain recommendations.",
      after: before,
    };
  return {
    ...base,
    mode: "APPLIED",
    reason:
      "Retention evidence tuned scoring and format mix; maximum weekly change is 0.05 per weight. Prompt/config remain recommendations.",
    after: { weights: { ...before.weights, ...weights }, formatMix },
  };
}
