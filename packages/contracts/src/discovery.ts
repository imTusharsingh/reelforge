import { z } from "zod";

export const DiscoveryFactors = [
  "novelty",
  "trendVelocity",
  "briefFit",
  "predictedRetention",
  "costFeasibility",
  "policySafety",
] as const;
export const DiscoveryFactorSchema = z.enum(DiscoveryFactors);
export const DiscoveryWeightsSchema = z.record(DiscoveryFactorSchema, z.number().min(0).max(1));
export const DiscoverySourceSchema = z
  .object({
    kind: z.enum(["SEARCH", "YOUTUBE", "ANALYTICS"]),
    url: z.url().refine((url) => url.startsWith("https://"), "HTTPS source required"),
    title: z.string().trim().min(1).max(300),
  })
  .strict();
export const DiscoveryCandidateSchema = z
  .object({
    topic: z.string().trim().min(1).max(300),
    hook: z.string().trim().min(1).max(300),
    angle: z.string().trim().min(1).max(1000),
    formatKey: z.string().trim().min(1).max(100),
    sources: z.array(DiscoverySourceSchema).min(1).max(20),
    trendVelocity: z.number().min(0).max(1),
    briefFit: z.number().min(0).max(1),
    predictedRetention: z.number().min(0).max(1),
    estimatedCostMinor: z.int().nonnegative(),
    policyRisk: z.number().min(0).max(1),
  })
  .strict();
export const DiscoveryCandidatesSchema = z.array(DiscoveryCandidateSchema).max(10);
export const RankedIdeaSchema = DiscoveryCandidateSchema.extend({
  id: z.uuid(),
  score: z.number().min(0).max(1),
  factors: DiscoveryWeightsSchema,
});
export const LearningStateSchema = z
  .object({
    weights: DiscoveryWeightsSchema,
    formatMix: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();
export const LearnedChangeSchema = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    week: z.string(),
    mode: z.enum(["APPLIED", "RECOMMENDATION", "INSUFFICIENT_DATA"]),
    reason: z.string(),
    before: LearningStateSchema,
    after: LearningStateSchema,
    evidenceSnapshotIds: z.array(z.uuid()),
  })
  .strict();
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
export type RankedIdea = z.infer<typeof RankedIdeaSchema>;
export type LearningState = z.infer<typeof LearningStateSchema>;
export type LearnedChange = z.infer<typeof LearnedChangeSchema>;
export type DiscoveryWeights = z.infer<typeof DiscoveryWeightsSchema>;
