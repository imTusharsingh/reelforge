import type { Prisma } from "@reelforge/database";

/**
 * The single "current review" predicate used by quality reads and publishing checks.
 * A current review is not superseded and has not had a replacement recorded.
 */
export const currentQualityReviewFilter = {
  status: { not: "SUPERSEDED" },
  supersededAt: null,
} satisfies Prisma.QualityReviewRunWhereInput;

export const currentQualityReviewOrder = [
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.QualityReviewRunOrderByWithRelationInput[];

export function currentQualityReviewWhere(
  workspaceId: string,
  renderJobId: string,
): Prisma.QualityReviewRunWhereInput {
  return { workspaceId, renderJobId, ...currentQualityReviewFilter };
}
