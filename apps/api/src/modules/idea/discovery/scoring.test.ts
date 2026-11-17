import { describe, expect, it } from "vitest";
import { DiscoveryCandidatesSchema } from "@reelforge/contracts";
import { initialLearning, normalizeTopic, rankCandidates, topicSimilarity } from "./scoring.js";
import { briefFixture, candidateFixture, now } from "./discovery.fixture.js";

describe("V10 ranking and cooldown", () => {
  it("ranks six factors with sources and learned format mix", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    const weak = { ...candidateFixture("Why stars shine"), briefFit: 0.1, trendVelocity: 0 };
    const ranked = rankCandidates([weak, candidateFixture()], brief, [], state, now);
    expect(ranked[0]?.topic).toBe(candidateFixture().topic);
    expect(ranked[0]?.sources).toEqual(candidateFixture().sources);
    expect(Object.keys(ranked[0]!.factors)).toHaveLength(6);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
  it("rejects normalized and near duplicate topics inside seven days, including drafts", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    const history = [{ topic: "HOW ocean tides work!", createdAt: now }];
    expect(rankCandidates([candidateFixture()], brief, history, state, now)).toEqual([]);
    expect(
      rankCandidates([candidateFixture("How ocean tides work today")], brief, history, state, now),
    ).toEqual([]);
    expect(
      rankCandidates(
        [candidateFixture()],
        brief,
        [{ ...history[0]!, createdAt: new Date(now.getTime() - 8 * 86400000) }],
        state,
        now,
      ),
    ).toHaveLength(1);
    expect(
      rankCandidates([candidateFixture(), candidateFixture()], brief, [], state, now),
    ).toHaveLength(1);
    expect(normalizeTopic("  Ｍoon... ROCKS ")).toBe("moon rocks");
    expect(topicSimilarity("", "")).toBe(0);
  });
  it("fails policy, budget, unknown format and banned topics closed", () => {
    const brief = briefFixture(),
      state = initialLearning(brief);
    brief.guardrails.bannedTopics = ["tides"];
    expect(rankCandidates([candidateFixture()], brief, [], state, now)).toEqual([]);
    brief.guardrails.bannedTopics = [];
    for (const override of [
      { policyRisk: 0.9 },
      { estimatedCostMinor: 99999 },
      { formatKey: "unknown" },
    ])
      expect(
        rankCandidates([{ ...candidateFixture(), ...override }], brief, [], state, now),
      ).toEqual([]);
  });
  it("validates provider output and rejects absent, insecure or invalid sources", () => {
    expect(DiscoveryCandidatesSchema.parse([candidateFixture()])).toHaveLength(1);
    for (const override of [
      { sources: [] },
      { predictedRetention: 2 },
      { sources: [{ kind: "SEARCH", url: "http://example.com", title: "source" }] },
    ])
      expect(
        DiscoveryCandidatesSchema.safeParse([{ ...candidateFixture(), ...override }]).success,
      ).toBe(false);
  });
});
