import type { Prisma, PrismaClient } from "@reelforge/database";
import type { Context } from "../runs/runs.types.js";
import {
  missedYouTubeSlot,
  rejectedYouTubeInsert,
  youTubeSlotElapsed,
} from "../social-accounts/scheduled-youtube.js";
import type { AutoSlot } from "./automation-slots.js";

export type PartialYouTubeProbe = { attemptId: string; startedAt: number; nextByte: number };
const partialGraceMs = 180_000;

/** Re-read durable evidence after serializing with insert dispatch and attempt claims. */
export async function markElapsedSlotMissed(
  db: PrismaClient,
  context: Context,
  slot: AutoSlot,
  destinationId: string,
  partial?: PartialYouTubeProbe,
): Promise<boolean> {
  const { workspaceId } = context;
  return db.$transaction(async (tx) => {
    // Insert dispatch locks the run before claiming the lease. Attempt claims lock the job.
    const runs = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM video_runs
      WHERE workspace_id = ${workspaceId}::uuid AND id = ${slot.runId}::uuid
        AND state = 'SCHEDULED' AND pause_reason IS NULL FOR UPDATE`;
    if (!runs.length) return false;
    const jobs = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM publish_jobs
      WHERE workspace_id = ${workspaceId}::uuid AND destination_id = ${destinationId}::uuid FOR UPDATE`;
    const jobId = jobs[0]?.id;
    if (!jobId || !youTubeSlotElapsed(slot.scheduledAt)) return false;
    if (!(await missedEvidence(tx, slot, destinationId, jobId, partial))) return false;
    const changed = await tx.v9PublishSlot.updateMany({
      where: { workspaceId, id: slot.id, status: { notIn: ["COMPLETE", "DRY_RUN"] } },
      data: { status: "MISSED", lastError: missedYouTubeSlot },
    });
    return changed.count > 0;
  });
}

async function missedEvidence(
  tx: Prisma.TransactionClient,
  slot: AutoSlot,
  destinationId: string,
  jobId: string,
  partial?: PartialYouTubeProbe,
): Promise<boolean> {
  const { workspaceId } = slot;
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
    select: {
      id: true,
      status: true,
      sessionCiphertext: true,
      remotePostId: true,
      errorCode: true,
      confirmedBytes: true,
    },
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
  const rejectedCode = attempt?.errorCode;
  const rejected =
    !attempt?.sessionCiphertext &&
    attempt?.status === "FAILED_FINAL" &&
    (rejectedCode === rejectedYouTubeInsert || rejectedCode === "YOUTUBE_RECONNECT_REQUIRED") &&
    destination.status === "FAILED_FINAL" &&
    destination.lastErrorCode === rejectedCode &&
    (lease?.status === "DISPATCHED" || lease?.status === "CONSUMED");
  const confirmedPartial =
    partial &&
    partial.startedAt >= slot.scheduledAt.getTime() + partialGraceMs &&
    attempt?.id === partial.attemptId &&
    attempt.confirmedBytes === BigInt(partial.nextByte) &&
    attempt.status === "FAILED_RETRYABLE" &&
    destination.status === "FAILED_RETRYABLE" &&
    !!attempt.sessionCiphertext;
  return unused || rejected || !!confirmedPartial;
}
