import { describe, expect, it } from "vitest";
import { DiscoveryFactors } from "@reelforge/contracts";
import { briefFixture, now } from "../idea/discovery/discovery.fixture.js";
import { initialLearning } from "../idea/discovery/scoring.js";
import type { LearningSample } from "../idea/discovery/types.js";
import { learningWeek, proposeLearning, WEEKLY_MAX_DELTA } from "./learning-policy.js";

const auditId = "77777777-7777-4777-8777-777777777777";
function samples(): LearningSample[] {
  const state = initialLearning(briefFixture());
  return [0, 1, 2, 3].map((i) => ({
    videoId: `v${i}`,
    formatKey: i < 2 ? Object.keys(state.formatMix)[0]! : Object.keys(state.formatMix)[1]!,
    retention: i < 2 ? 0.9 : 0.2,
    factors: { ...state.weights, briefFit: i < 2 ? 1 : 0, novelty: i < 2 ? 0 : 1 },
    evidenceSnapshotIds: [auditId],
  }));
}
describe("V10 bounded audited learning", () => {
  it("applies normalized scoring and format changes within explicit bounds", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    brief.tuningBounds = {
      scoringWeights: Object.fromEntries(DiscoveryFactors.map((key) => [key, { min: 0, max: 1 }])),
      formatMix: Object.fromEntries(
        Object.keys(state.formatMix).map((key) => [key, { min: 0, max: 1 }]),
      ),
    };
    const change = proposeLearning(brief, state, samples(), now, auditId);
    expect(change.mode).toBe("APPLIED");
    expect(change.after.weights.briefFit).toBeGreaterThan(state.weights.briefFit);
    expect(change.after.weights.novelty).toBeLessThan(state.weights.novelty);
    for (const key of DiscoveryFactors)
      expect(Math.abs(change.after.weights[key] - state.weights[key])).toBeLessThanOrEqual(
        WEEKLY_MAX_DELTA + 1e-10,
      );
    expect(Object.values(change.after.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Object.values(change.after.formatMix).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(change.evidenceSnapshotIds).toEqual([auditId]);
    expect(change.before).toEqual(state);
    expect(change.reason).toContain("Prompt/config remain recommendations");
  });
  it("requires sufficient distinct videos and never tunes prompts or missing bounds", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    const rec = proposeLearning(brief, state, samples(), now, auditId);
    expect(rec.mode).toBe("RECOMMENDATION");
    expect(rec.after).toEqual(state);
    expect(
      proposeLearning(brief, state, [samples()[0]!, samples()[0]!, samples()[1]!], now, auditId)
        .mode,
    ).toBe("INSUFFICIENT_DATA");
    brief.tuningBounds = { scoringWeights: {}, formatMix: {} };
    expect(proposeLearning(brief, state, samples(), now, auditId).mode).toBe("RECOMMENDATION");
    expect(learningWeek(new Date("2026-11-22T23:59:00Z"))).toBe("2026-11-16");
    expect(learningWeek(new Date("2026-11-23T00:00:00Z"))).toBe("2026-11-23");
  });
  it("honors tight bounds and leaves equal signals unchanged", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    brief.tuningBounds = {
      scoringWeights: Object.fromEntries(
        DiscoveryFactors.map((key) => [key, { min: state.weights[key], max: state.weights[key] }]),
      ),
      formatMix: Object.fromEntries(
        Object.entries(state.formatMix).map(([key, weight]) => [key, { min: weight, max: weight }]),
      ),
    };
    expect(proposeLearning(brief, state, samples(), now, auditId).after).toEqual(state);
    expect(
      proposeLearning(
        brief,
        state,
        samples().map((row) => ({ ...row, retention: 0.5 })),
        now,
        auditId,
      ).after,
    ).toEqual(state);
  });
});
