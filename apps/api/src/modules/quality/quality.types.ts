import type {
  QualityReviewCriterion,
  QualityReviewCriterionResult,
  ProviderProvenance,
} from "@reelforge/ai-providers";

export type HardGateId =
  | "ARTIFACT_INTEGRITY"
  | "ASPECT_RATIO"
  | "DURATION"
  | "VIDEO_CODEC"
  | "AUDIO"
  | "SUBTITLES"
  | "SCRIPT_PROVENANCE"
  | "GENRE_POLICY"
  | "APPROVAL_POLICY"
  | "ASSET_RIGHTS"
  | "DISCLOSURES";

export type HardGateResult = Readonly<{
  id: HardGateId;
  passed: boolean;
  evidence: ReadonlyArray<string>;
}>;

export type QualityRunStatus =
  | "BLOCKED"
  | "AI_REVIEW_UNAVAILABLE"
  | "REVIEW_REQUIRED"
  | "AUTO_APPROVED"
  | "APPROVED"
  | "REJECTED"
  | "CHANGES_REQUESTED";
export type QualityDecisionAction = "APPROVE" | "REJECT" | "REQUEST_CHANGES";

export type QualityScorecard = Readonly<{
  criteria: Readonly<Record<QualityReviewCriterion, QualityReviewCriterionResult>>;
  score: number;
  metadata: ProviderProvenance;
}>;

export type ApprovalPolicy = Readonly<{
  mode: "MANUAL" | "AUTO";
  scoreThreshold: number;
  criterionThresholds: Partial<Record<QualityReviewCriterion, number>>;
}>;

export type RegenerationTarget = Readonly<{
  stage: "SCENE" | "SCRIPT" | "RENDER";
  sceneId?: string;
}>;

export type QualityRunView = Readonly<{
  id: string;
  renderJobId: string;
  status: QualityRunStatus;
  gateSummary: ReadonlyArray<HardGateResult>;
  scorecard: QualityScorecard | null;
  policySnapshot: ApprovalPolicy;
  disclosures: ReadonlyArray<string>;
  limitations: ReadonlyArray<string>;
  decisions: ReadonlyArray<
    Readonly<{
      id: string;
      action: QualityDecisionAction;
      reason: string;
      actorUserId: string;
      createdAt: string;
    }>
  >;
  regenerationRequests: ReadonlyArray<
    Readonly<{
      id: string;
      stage: "SCENE" | "SCRIPT" | "RENDER";
      sceneId: string | null;
      attempt: number;
      createdAt: string;
    }>
  >;
  createdAt: string;
}>;
