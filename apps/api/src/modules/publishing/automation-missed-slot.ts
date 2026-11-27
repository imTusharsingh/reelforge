import type { PrismaClient } from "@reelforge/database";
import type { Context } from "../runs/runs.types.js";
import { missedYouTubeSlot, youTubeSlotElapsed } from "../social-accounts/scheduled-youtube.js";
import type { AutoSlot } from "./automation-slots.js";

/** Re-read durable evidence after serializing with insert dispatch and attempt claims. */
export async function markElapsedSlotMissed(
  db: PrismaClient,
  context: Context,
  slot: AutoSlot,
  destinationId: string,
  partialAfterGrace: boolean,
): Promise<boolean> {
  const { workspaceId } = context;
  return db.$transaction(async (tx) => {
    // Insert dispatch locks the run before claiming the lease. Attempt claims lock the job.
    await tx.$queryRaw`SELECT id FROM video_runs
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${slot.runId}::uuid FOR UPDATE`;
    const jobs = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM publish_jobs
      WHERE workspace_id = ${workspaceId}::uuid AND destination_id = ${destinationId}::uuid FOR UPDATE`;
    const jobId = jobs[0]?.id;
    if (!jobId || !youTubeSlotElapsed(slot.scheduledAt)) return false;
    const lease = await tx.v9InsertLease.findUnique({
      where: { workspaceId_slotId: { workspaceId, slotId: slot.id } },
      select: { status: true },
    });
    const destination = await tx.publishingDestination.findUnique({
      where: { workspaceId_id: { workspaceId, id: destinationId } },
      select: { status: true, remotePostId: true, lastErrorCode: true },
    });
    const attempt = await tx.publishAttempt.findFirst({
      where: { workspaceId, publishJobId: jobId },
      orderBy: { attemptNumber: "desc" },
      select: { status: true, sessionCiphertext: true, remotePostId: true },
    });
    if (
      !destination ||
      destination.status === "PUBLISHED" ||
      destination.remotePostId ||
      attempt?.remotePostId
    )
      return false;
    const unused =
      !attempt?.sessionCiphertext &&
      (lease?.status === "RESERVED" ||
        (!lease && !attempt) ||
        (destination.status === "FAILED_FINAL" && destination.lastErrorCode === missedYouTubeSlot));
    const confirmedPartial =
      partialAfterGrace &&
      attempt?.status === "FAILED_RETRYABLE" &&
      destination.status === "FAILED_RETRYABLE" &&
      !!attempt.sessionCiphertext;
    if (!unused && !confirmedPartial) return false;
    const changed = await tx.v9PublishSlot.updateMany({
      where: { workspaceId, id: slot.id, status: { notIn: ["COMPLETE", "DRY_RUN"] } },
      data: { status: "MISSED", lastError: missedYouTubeSlot },
    });
    return changed.count > 0;
  });
}
