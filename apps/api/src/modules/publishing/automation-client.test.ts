import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reelforge/database";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import { publishingClient, isScheduledAutomation, reconnectRequired } from "./automation-client.js";
import { context, id } from "./automation.fixture.js";
afterEach(() => vi.unstubAllEnvs());
describe("V9 insert dispatch fence on fake YouTube client", () => {
  it("starts one upload only; replays fail closed and chunk/reconcile methods are preserved", async () => {
    const startVideoUpload = vi.fn(async () => "fake-session");
    const checkVideoUpload = vi.fn();
    const social = {
      scheduledClient: vi.fn(async () => ({ startVideoUpload, checkVideoUpload })),
      authenticatedClient: vi.fn(),
    };
    let claimed = false;
    const db = {
      v9PublishSlot: {
        findFirst: vi.fn(async () => ({
          id: id(7),
          scheduledAt: new Date("2027-03-14T07:00:00Z"),
        })),
        count: vi.fn(async () => 1),
      },
      v9InsertLease: {
        updateMany: vi.fn(async () => {
          const count = claimed ? 0 : 1;
          claimed = true;
          return { count };
        }),
      },
    };
    const client = await publishingClient(
      db as unknown as PrismaClient,
      social as unknown as SocialAccountsService,
      context,
      { socialAccountId: id(8), scheduledPostId: id(10) },
    );
    const metadata = {
      platform: "YOUTUBE" as const,
      title: "Science",
      description: "",
      privacyStatus: "private" as const,
      selfDeclaredMadeForKids: false,
    };
    await client.startVideoUpload(metadata, 1, "video/mp4");
    await expect(client.startVideoUpload(metadata, 1, "video/mp4")).rejects.toThrow(
      "already dispatched",
    );
    expect(startVideoUpload).toHaveBeenCalledTimes(1);
    expect(client.checkVideoUpload).toBe(checkVideoUpload);
    expect(
      await isScheduledAutomation(db as unknown as PrismaClient, context.workspaceId, id(10)),
    ).toBe(true);
  });
  it("identifies reconnect holds and resolves historical accounts", async () => {
    const authenticatedClient = vi.fn(async () => ({ account: {} }));
    const client = await publishingClient(
      { v9PublishSlot: { findFirst: async () => null } } as unknown as PrismaClient,
      { authenticatedClient } as unknown as SocialAccountsService,
      context,
      { socialAccountId: id(8), scheduledPostId: id(10) },
    );
    expect(client).toMatchObject({ account: {} });
    expect(reconnectRequired(new Error("not connected"))).toBe(true);
    expect(reconnectRequired(new Error("quota"))).toBe(false);
  });
});
