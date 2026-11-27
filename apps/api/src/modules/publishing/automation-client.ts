import { ConflictException } from "@nestjs/common";
import type { PrismaClient } from "@reelforge/database";
import type {
  AuthenticatedPlatformClient,
  YouTubeUploadProgress,
} from "@reelforge/social-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { requireFutureYouTubeSlot } from "../social-accounts/scheduled-youtube.js";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
/** M13 remains responsible for encrypted sessions, offset recovery and attempt serialization. */
export async function publishingClient(
  db: PrismaClient,
  social: SocialAccountsService,
  context: WorkspaceContext,
  destination: { socialAccountId: string; scheduledPostId: string },
): Promise<AuthenticatedPlatformClient> {
  const slot = await db.v9PublishSlot.findFirst({
    where: { workspaceId: context.workspaceId, scheduledPostId: destination.scheduledPostId },
  });
  if (!slot) return social.authenticatedClient(context, destination.socialAccountId);
  const client = await social.scheduledClient(
    context,
    destination.socialAccountId,
    slot.scheduledAt.toISOString(),
  );
  return {
    ...client,
    uploadVideoChunk: async (...args): Promise<YouTubeUploadProgress> => {
      requireFutureYouTubeSlot(slot.scheduledAt);
      return client.uploadVideoChunk(...args);
    },
    startVideoUpload: async (metadata, bytes, contentType): Promise<string> => {
      const { upload } = await db.$transaction(async (tx) => {
        const runs = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM video_runs
          WHERE workspace_id = ${context.workspaceId}::uuid
            AND id = ${slot.runId}::uuid AND state = 'SCHEDULED' AND pause_reason IS NULL
          FOR UPDATE`;
        if (!runs.length) throw new ConflictException("Run is no longer scheduled for publishing");
        requireFutureYouTubeSlot(slot.scheduledAt);
        const claimed = await tx.v9InsertLease.updateMany({
          where: { workspaceId: context.workspaceId, slotId: slot.id, status: "RESERVED" },
          data: { status: "DISPATCHED" },
        });
        if (claimed.count !== 1)
          throw new ConflictException(
            "An insert was already dispatched; reconcile before another upload",
          );
        const upload = client.startVideoUpload(metadata, bytes, contentType);
        // The request starts under the run lock; the response can arrive after releasing it.
        void upload.catch(() => undefined);
        return { upload };
      });
      return upload;
    },
  };
}
export async function isScheduledAutomation(
  db: PrismaClient,
  workspaceId: string,
  scheduledPostId: string,
): Promise<boolean> {
  return (await db.v9PublishSlot.count({ where: { workspaceId, scheduledPostId } })) > 0;
}

export function reconnectRequired(error: unknown): boolean {
  if (error instanceof Error && /RECONNECT|reauth|not connected|token/i.test(error.message))
    return true;
  return (
    error !== null &&
    typeof error === "object" &&
    "getStatus" in error &&
    typeof error.getStatus === "function" &&
    [401, 403].includes(error.getStatus())
  );
}
