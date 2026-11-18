import type { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";

export async function seedHistoricalReview(
  db: Database,
  context: WorkspaceContext,
  renderJobId: string,
  workflowId: string,
): Promise<void> {
  const review = await db.qualityReviewRun.create({
    data: {
      workspaceId: context.workspaceId,
      renderJobId,
      renderFamilyId: renderJobId,
      createdByUserId: context.userId,
      status: "REVIEW_REQUIRED",
      gateSummary: [
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
      ].map((id) => ({ id, passed: true, evidence: ["Historical fixture"] })),
      policySnapshot: { mode: "MANUAL" },
      disclosures: [],
      limitations: ["Historical fixture"],
    },
  });
  const workflow = await db.workflowRun.findUniqueOrThrow({ where: { id: workflowId } });
  if (!workflow.input || typeof workflow.input !== "object" || Array.isArray(workflow.input))
    throw new Error("Invalid workflow fixture input");
  await db.workflowRun.update({
    where: { id: workflowId },
    data: {
      input: { ...(workflow.input as Prisma.InputJsonObject), qualityReviewRunId: review.id },
    },
  });
}
