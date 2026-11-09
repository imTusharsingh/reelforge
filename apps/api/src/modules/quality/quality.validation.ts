import { z } from "zod";
import type { QualityReviewCriterion } from "@reelforge/ai-providers";
import type { ApprovalPolicy } from "./quality.types.js";

export const QUALITY_CRITERIA = [
  "FACTUALITY",
  "CLARITY",
  "COHERENCE",
  "ENGAGEMENT",
  "GENRE_FIT",
] as const satisfies readonly QualityReviewCriterion[];

const score = z.number().finite().int().min(0).max(100);
const criterion = z
  .object({
    score,
    evidence: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(20),
  })
  .strict();

export const hardGateSummarySchema = z.array(
  z
    .object({
      id: z.enum([
        "ARTIFACT_INTEGRITY",
        "ASPECT_RATIO",
        "DURATION",
        "VIDEO_CODEC",
        "AUDIO",
        "SUBTITLES",
        "SCRIPT_PROVENANCE",
        "GENRE_POLICY",
        "APPROVAL_POLICY",
        "ASSET_RIGHTS",
        "DISCLOSURES",
      ]),
      passed: z.boolean(),
      evidence: z.array(z.string().min(1)),
    })
    .strict(),
);

export const qualityReviewResultSchema = z
  .object({
    criteria: z
      .object({
        FACTUALITY: criterion,
        CLARITY: criterion,
        COHERENCE: criterion,
        ENGAGEMENT: criterion,
        GENRE_FIT: criterion,
      })
      .strict(),
    metadata: z
      .object({
        modelVersion: z.string().trim().min(1).max(200),
        promptVersion: z.string().trim().min(1).max(200),
        cost: z.number().finite().nonnegative().nullable(),
        currency: z.string().trim().min(1).max(20).optional(),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
            seconds: z.number().finite().nonnegative().optional(),
            characters: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const qualityScorecardSchema = z
  .object({
    criteria: z
      .object({
        FACTUALITY: criterion,
        CLARITY: criterion,
        COHERENCE: criterion,
        ENGAGEMENT: criterion,
        GENRE_FIT: criterion,
      })
      .strict(),
    score,
    metadata: qualityReviewResultSchema.shape.metadata,
  })
  .strict();

export const approvalPolicySchema = z.object({
  mode: z.enum(["MANUAL", "AUTO"]).default("MANUAL"),
  scoreThreshold: score.default(80),
  criterionThresholds: z
    .object({
      FACTUALITY: score.optional(),
      CLARITY: score.optional(),
      COHERENCE: score.optional(),
      ENGAGEMENT: score.optional(),
      GENRE_FIT: score.optional(),
    })
    .strict()
    .default({}),
});

export const decisionSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
    reason: z.string().trim().min(1).max(4000),
    regeneration: z
      .discriminatedUnion("stage", [
        z
          .object({ stage: z.literal("SCENE"), sceneId: z.string().trim().min(1).max(200) })
          .strict(),
        z.object({ stage: z.literal("SCRIPT") }).strict(),
        z.object({ stage: z.literal("RENDER") }).strict(),
      ])
      .optional(),
  })
  .strict();

export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === null || value === undefined)
    return { mode: "MANUAL", scoreThreshold: 80, criterionThresholds: {} };
  const parsed = approvalPolicySchema.parse(value);
  const criterionThresholds: Partial<Record<QualityReviewCriterion, number>> = {};
  for (const key of QUALITY_CRITERIA) {
    const threshold = parsed.criterionThresholds[key];
    if (threshold !== undefined) criterionThresholds[key] = threshold;
  }
  return {
    mode: parsed.mode,
    scoreThreshold: parsed.scoreThreshold,
    criterionThresholds,
  };
}
