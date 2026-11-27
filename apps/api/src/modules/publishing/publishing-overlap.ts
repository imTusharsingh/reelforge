import type { Prisma } from "@reelforge/database";

/** A job has one published destination. A competing attempt is no longer active
 * once that destination is confirmed. Do not claim it produced the video. */
export async function closeOverlappingAttempts(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  publishJobId: string,
  finishedAt: Date,
): Promise<void> {
  await tx.publishAttempt.updateMany({
    where: {
      workspaceId,
      publishJobId,
      status: { notIn: ["SUCCEEDED", "FAILED_FINAL"] },
    },
    data: {
      status: "FAILED_FINAL",
      errorCode: "UPLOAD_SUPERSEDED",
      errorMessage: "Another upload attempt already confirmed this destination.",
      finishedAt,
    },
  });
}
