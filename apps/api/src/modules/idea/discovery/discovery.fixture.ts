import { defaultBrief, type ChannelBrief, type DiscoveryCandidate } from "@reelforge/contracts";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const channelId = "22222222-2222-4222-8222-222222222222";
export const context = {
  workspaceId,
  userId: "33333333-3333-4333-8333-333333333333",
  role: "OWNER" as const,
};
export const now = new Date("2026-11-16T15:00:00Z");
export function briefFixture(): ChannelBrief {
  return {
    ...defaultBrief({
      niche: "Science",
      audience: "Adults",
      language: "English",
      voiceId: "Kore",
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
    }),
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId,
    channelId,
    schemaVersion: "1.0",
    version: 1,
  };
}
export function candidateFixture(topic = "How ocean tides work"): DiscoveryCandidate {
  return {
    topic,
    hook: "The Moon moves oceans",
    angle: "Explain tidal forces",
    formatKey: briefFixture().formatMix[0]!.formatKey,
    sources: [{ kind: "SEARCH", url: "https://science.nasa.gov/moon/", title: "Moon science" }],
    trendVelocity: 0.8,
    briefFit: 0.9,
    predictedRetention: 0.7,
    estimatedCostMinor: 500,
    policyRisk: 0,
  };
}
