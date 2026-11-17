import { screenPlanningContent } from "../../script/planning-guardrails.js";
import {
  DiscoveryFactors,
  type ChannelBrief,
  type DiscoveryCandidate,
  type DiscoveryWeights,
  type LearningState,
} from "@reelforge/contracts";

export const DEFAULT_WEIGHTS: DiscoveryWeights = {
  novelty: 0.2,
  trendVelocity: 0.15,
  briefFit: 0.25,
  predictedRetention: 0.2,
  costFeasibility: 0.1,
  policySafety: 0.1,
};
export function normalizeTopic(topic: string): string {
  return topic
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function topicSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTopic(a).split(" ").filter(Boolean));
  const right = new Set(normalizeTopic(b).split(" ").filter(Boolean));
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / Math.max(1, new Set([...left, ...right]).size);
}
export function initialLearning(brief: ChannelBrief): LearningState {
  return {
    weights: { ...DEFAULT_WEIGHTS },
    formatMix: Object.fromEntries(brief.formatMix.map((item) => [item.formatKey, item.weight])),
  };
}
export function rankCandidates(
  candidates: readonly DiscoveryCandidate[],
  brief: ChannelBrief,
  history: readonly { topic: string; createdAt: Date }[],
  state: LearningState,
  now: Date,
): Array<DiscoveryCandidate & { score: number; factors: DiscoveryWeights }> {
  const accepted: string[] = [];
  const banned = [...brief.guardrails.bannedTopics, ...brief.guardrails.topicsToAvoid].map(
    normalizeTopic,
  );
  return candidates
    .flatMap((idea) => {
      try {
        screenPlanningContent(
          { brief, runId: brief.id, idea: idea.topic, format: "explainer" },
          `${idea.topic} ${idea.hook} ${idea.angle}`,
        );
      } catch {
        return [];
      }
      const topic = normalizeTopic(idea.topic);
      const content = normalizeTopic(`${idea.topic} ${idea.hook} ${idea.angle}`);
      const duplicate = history.some(
        (row) =>
          now.getTime() - row.createdAt.getTime() < 7 * 86400000 &&
          topicSimilarity(row.topic, topic) >= 0.55,
      );
      if (
        duplicate ||
        accepted.some((old) => topicSimilarity(old, topic) >= 0.55) ||
        banned.some((word) => content.includes(word)) ||
        idea.policyRisk > 0.2 ||
        idea.estimatedCostMinor > brief.budgetPolicy.hardCapMinor ||
        !(idea.formatKey in state.formatMix)
      )
        return [];
      accepted.push(topic);
      const factors: DiscoveryWeights = {
        novelty: 1 - Math.max(0, ...history.map((row) => topicSimilarity(row.topic, topic))),
        trendVelocity: idea.trendVelocity,
        briefFit: idea.briefFit,
        predictedRetention: idea.predictedRetention,
        costFeasibility: 1 - idea.estimatedCostMinor / Math.max(1, brief.budgetPolicy.hardCapMinor),
        policySafety: 1 - idea.policyRisk,
      };
      const score =
        DiscoveryFactors.reduce((sum, key) => sum + factors[key] * state.weights[key], 0) *
        (0.9 + 0.1 * (state.formatMix[idea.formatKey] ?? 0));
      return [{ ...idea, score, factors }];
    })
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
}
