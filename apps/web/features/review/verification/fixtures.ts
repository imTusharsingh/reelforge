import { criteria, gateIds, type Run, type Scorecard } from "../model";
export { renderId, workspaceId } from "../../production/verification/fixtures";
import { render as sourceRender, renderId, scriptId } from "../../production/verification/fixtures";
export const runId = "80000000-0000-4000-8000-000000000008";
export const scorecard: Scorecard = {
  score: 84,
  criteria: Object.fromEntries(
    criteria.map((id) => [
      id,
      {
        score: 84,
        evidence: [`Recorded ${id.toLowerCase()} evidence`],
        limitations: ["Text-only review"],
      },
    ]),
  ) as Scorecard["criteria"],
  metadata: { modelVersion: "fixture-model-v1", promptVersion: "fixture-prompt-v1", cost: null },
};
export const review: Run = {
  id: runId,
  renderJobId: renderId,
  status: "AI_REVIEW_UNAVAILABLE",
  gateSummary: gateIds.map((id) => ({
    id,
    passed: true,
    evidence: [`Recorded ${id.toLowerCase()} evidence`],
  })),
  scorecard: null,
  policySnapshot: { mode: "MANUAL", scoreThreshold: 80, criterionThresholds: {} },
  disclosures: ["AI_GENERATED_ASSET"],
  limitations: ["AI provider not configured"],
  decisions: [],
  regenerationRequests: [],
  createdAt: "2026-11-12T05:00:00.000Z",
  supersededAt: null,
};

export const render = {
  ...sourceRender,
  input: {
    ...sourceRender.input,
    sourceMediaPackage: { scriptId },
    scenes: [{ sceneId: "scene-one" }, { sceneId: "scene-two" }],
  },
};
