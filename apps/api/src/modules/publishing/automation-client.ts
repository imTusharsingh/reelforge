import { ConflictException } from "@nestjs/common";
import type { PrismaClient } from "@reelforge/database";
import type { AuthenticatedPlatformClient } from "@reelforge/social-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";
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
    startVideoUpload: async (metadata, bytes, contentType): Promise<string> => {
      const claimed = await db.v9InsertLease.updateMany({
        where: { workspaceId: context.workspaceId, slotId: slot.id, status: "RESERVED" },
        data: { status: "DISPATCHED" },
      });
      if (claimed.count !== 1)
        throw new ConflictException(
          "An insert was already dispatched; reconcile before another upload",
        );
      return client.startVideoUpload(metadata, bytes, contentType);
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
