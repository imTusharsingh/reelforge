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
import { PublishingService } from "./publishing.service.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";
import type { ScheduledPostView } from "./publishing.types.js";

async function seedApprovedSlot(
  db: PrismaClient,
  source: { workspaceId: string; channelId: string; accountId: string },
  postId: string,
  scheduledAt: Date,
): Promise<void> {
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
  await db.v9PublishSlot.create({
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
  await seedApprovedSlot(db, source, post.id, scheduledAt);
  const job = await db.publishJob.findFirstOrThrow({ where: { destinationId: destination.id } });
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
    return videoResponse(privacyStatus);
  });
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
  const probe = vi.fn(async (uri: string, bytes: number): Promise<YouTubeUploadProgress> => {
    expect(uri).toBe(sessionUri);
    expect(bytes).toBe(12);
    return { completed: true, videoId, nextByte: 12 };
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
    const completions = await Promise.all([reconcile(), reconcile()]);
    stale.resolve(videoResponse("private"));
    await slowPrivate;
    for (const result of completions)
      expect(result.destinations[0]).toMatchObject({
        status: "PUBLISHED",
        remotePostId: videoId,
      });
    expect((await reconcile()).destinations[0]).toMatchObject({
      status: "PUBLISHED",
      remotePostId: videoId,
    });
    expect(await eventCount()).toBe(1);
    expect(probe).toHaveBeenCalledOnce();
    expect(await db.publishAttempt.count({ where: { publishJobId: job.id } })).toBe(1);
  } finally {
    stale.resolve(videoResponse("private"));
    time.mockRestore();
  }
}
