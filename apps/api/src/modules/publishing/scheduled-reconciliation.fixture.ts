import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { PrismaClient } from "@reelforge/database";
import type {
  AuthenticatedPlatformClient,
  VerifiedYouTubeVideo,
  YouTubeUploadProgress,
} from "@reelforge/social-providers";
import type { CompositionService } from "../composition/composition.service.js";
import type { QualityService } from "../quality/quality.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { ScheduledYouTube } from "../social-accounts/scheduled-youtube.js";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import {
  UnconfiguredPublishingSchedulePort,
  UnconfiguredPublishingBudgetPort,
} from "./publishing.ports.js";
import { markElapsedSlotMissed } from "./automation-missed-slot.js";
import type { AutoSlot } from "./automation-slots.js";
import { PublishingService } from "./publishing.service.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";
import type { ScheduledPostView } from "./publishing.types.js";

async function seedApprovedSlot(
  db: PrismaClient,
  source: { workspaceId: string; channelId: string; accountId: string },
  postId: string,
  scheduledAt: Date,
): Promise<AutoSlot> {
  const { workspaceId, channelId, accountId } = source;
  const brief = await db.channelBrief.create({
    data: { workspaceId, channelId, version: 1, document: {} },
  });
  const run = await db.videoRun.create({
    data: {
      workspaceId,
      channelId,
      channelBriefId: brief.id,
      state: "SCHEDULED",
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      inputSnapshot: {},
    },
  });
  return db.v9PublishSlot.create({
    data: {
      workspaceId,
      channelId,
      runId: run.id,
      socialAccountId: accountId,
      scheduledPostId: postId,
      scheduledAt,
      timezone: "UTC",
      package: {},
    },
  });
}

export async function verifyScheduledReconciliation(
  db: PrismaClient,
  context: WorkspaceContext,
  source: { workspaceId: string; channelId: string; accountId: string },
  post: ScheduledPostView,
  scheduledAt: Date,
): Promise<void> {
  const destination = post.destinations[0]!;
  const slot = await seedApprovedSlot(db, source, post.id, scheduledAt);
  const job = await db.publishJob.findFirstOrThrow({ where: { destinationId: destination.id } });
  await db.v9InsertLease.create({
    data: {
      workspaceId: context.workspaceId,
      slotId: slot.id,
      status: "DISPATCHED",
      projectKey: "fixture",
      quotaDay: "2026-11-27",
    },
  });
  const videoId = "confirmed-private-test-id";
  // Simulate a lost final response: only the encrypted resumable session is durable.
  const attemptId = randomUUID();
  const sessionUri = "https://www.googleapis.com/upload/session/fixture";
  const vault = new PublishingSessionVault(Buffer.alloc(32, 7).toString("base64url"));
  const session = vault.encrypt(
    sessionUri,
    `${context.workspaceId}:${job.id}:${attemptId}:youtube-upload-session`,
  );
  await db.publishAttempt.create({
    data: {
      workspaceId: context.workspaceId,
      publishJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: randomUUID(),
      status: "RECONCILIATION_REQUIRED",
      id: attemptId,
      totalBytes: 12,
      sessionCiphertext: session.ciphertext,
      sessionNonce: session.nonce,
      sessionTag: session.tag,
      sessionKeyVersion: session.keyVersion,
    },
  });

  const stale = Promise.withResolvers<Response>();
  let privacyStatus = "private";
  let hold = false;
  const provider = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
    expect(init?.method ?? "GET").toBe("GET");
    expect(new URL(String(url)).searchParams.get("id")).toBe(videoId);
    if (hold) {
      hold = false;
      return stale.promise;
    }
    if (privacyStatus === "public" && !resumeRecorded) {
      resumeRecorded = true;
      await startOverlappingResume();
    }
    return videoResponse(privacyStatus);
  });
  const resumedId = randomUUID();
  let resumeRecorded = false;
  async function startOverlappingResume(): Promise<void> {
    const encrypted = vault.encrypt(
      sessionUri,
      `${context.workspaceId}:${job.id}:${resumedId}:youtube-upload-session`,
    );
    await db.publishAttempt.create({
      data: {
        workspaceId: context.workspaceId,
        publishJobId: job.id,
        attemptNumber: 2,
        idempotencyKey: randomUUID(),
        status: "STARTED",
        id: resumedId,
        totalBytes: 12,
        sessionCiphertext: encrypted.ciphertext,
        sessionNonce: encrypted.nonce,
        sessionTag: encrypted.tag,
        sessionKeyVersion: encrypted.keyVersion,
      },
    });
  }
  const videoResponse = (privacy: string): Response =>
    Response.json({
      items: [
        {
          id: videoId,
          snippet: { channelId: "fixture-channel", title: "Fixture", description: "" },
          status: {
            privacyStatus: privacy,
            uploadStatus: "processed",
            containsSyntheticMedia: true,
            ...(privacy === "private" ? { publishAt: scheduledAt.toISOString() } : {}),
          },
        },
      ],
    });
  const youtube = new ScheduledYouTube(provider);
  const lateFinal = Promise.withResolvers<YouTubeUploadProgress>();
  const firstProbe = Promise.withResolvers<void>();
  const completed = { completed: true as const, videoId, nextByte: 12 };
  const probe = vi.fn(async (uri: string, bytes: number): Promise<YouTubeUploadProgress> => {
    expect(uri).toBe(sessionUri);
    expect(bytes).toBe(12);
    if (probe.mock.calls.length === 1) {
      firstProbe.resolve();
      return lateFinal.promise;
    }
    return completed;
  });
  const offline = new PublishingService(
    db,
    {} as CompositionService,
    {} as QualityService,
    {
      scheduledClient: async (): Promise<
        Pick<AuthenticatedPlatformClient, "checkVideoUpload" | "verifyUploadedVideo">
      > => ({
        checkVideoUpload: probe,
        verifyUploadedVideo: (
          id: string,
          metadata: Parameters<ScheduledYouTube["verify"]>[3],
        ): Promise<VerifiedYouTubeVideo> =>
          youtube.verify(
            "fixture-token",
            id,
            "fixture-channel",
            metadata,
            scheduledAt.toISOString(),
          ),
      }),
    } as unknown as SocialAccountsService,
    {} as StoragePort,
    new UnconfiguredPublishingSchedulePort(),
    new UnconfiguredPublishingBudgetPort(),
    vault,
  );
  const reconcile = (): ReturnType<PublishingService["reconcile"]> =>
    offline.reconcile(context, destination.id);
  const eventCount = (): Promise<number> =>
    db.outboxEvent.count({
      where: {
        workspaceId: context.workspaceId,
        aggregateId: destination.id,
        eventType: "PostPublished",
      },
    });
  const delayedFinalResponse = reconcile();
  await firstProbe.promise;
  expect((await reconcile()).destinations[0]).toMatchObject({
    status: "REMOTE_PROCESSING",
    remotePostId: videoId,
  });
  expect(await eventCount()).toBe(0);
  hold = true;
  const slowPrivate = reconcile();
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
  privacyStatus = "public";
  const time = vi.spyOn(Date, "now").mockReturnValue(scheduledAt.getTime());
  try {
    expect(await markElapsedSlotMissed(db, context, slot, destination.id)).toBe(false);
    const completedPost = await reconcile();
    stale.resolve(videoResponse("private"));
    await slowPrivate;
    const verifiedReads = provider.mock.calls.length;
    lateFinal.resolve(completed);
    await delayedFinalResponse;
    expect(provider).toHaveBeenCalledTimes(verifiedReads);
    expect(await db.publishAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
      status: "SUCCEEDED",
      remotePostId: videoId,
    });
    expect(completedPost.destinations[0]).toMatchObject({
      status: "PUBLISHED",
      remotePostId: videoId,
      latestAttempt: { id: resumedId, status: "FAILED_FINAL", errorCode: "UPLOAD_SUPERSEDED" },
    });
    expect(await db.publishAttempt.findUniqueOrThrow({ where: { id: resumedId } })).toMatchObject({
      status: "FAILED_FINAL",
      finishedAt: expect.any(Date),
    });
    expect((await reconcile()).destinations[0]).toMatchObject({
      status: "PUBLISHED",
      remotePostId: videoId,
    });
    expect(await eventCount()).toBe(1);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await db.publishAttempt.count({ where: { publishJobId: job.id } })).toBe(2);
  } finally {
    stale.resolve(videoResponse("private"));
    lateFinal.resolve(completed);
    await Promise.allSettled([slowPrivate, delayedFinalResponse]);
    time.mockRestore();
  }
}
