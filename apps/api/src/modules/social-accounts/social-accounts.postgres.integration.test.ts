import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const userId = randomUUID();
const channelId = randomUUID();
const accountId = randomUUID();
const otherAccountId = randomUUID();
const oauthStateId = randomUUID();

suite("M12 PostgreSQL persistence", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({
      data: { id: userId, email: `${userId}@social.integration.invalid` },
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "social-integration" },
        { id: otherWorkspaceId, name: "other-social-integration" },
      ],
    });
    await db.workspaceMembership.create({
      data: { workspaceId, userId, role: "OWNER" },
    });
    await db.channel.create({
      data: { id: channelId, workspaceId, name: "social-integration" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("persists tenant-scoped accounts, encrypted-token material, permissions, capabilities, and one-use states", async () => {
    if (!db) return;
    const account = await db.socialAccount.create({
      data: {
        id: accountId,
        workspaceId,
        channelId,
        platform: "YOUTUBE",
        remoteAccountId: "UC-fixture",
        displayName: "Fixture channel",
        status: "CONNECTED",
        health: "HEALTHY",
        tokens: {
          create: {
            accessTokenCiphertext: "ciphertext-fixture",
            accessTokenNonce: "nonce-fixture",
            accessTokenTag: "tag-fixture",
            refreshTokenCiphertext: "refresh-ciphertext-fixture",
            refreshTokenNonce: "refresh-nonce-fixture",
            refreshTokenTag: "refresh-tag-fixture",
            encryptionKeyVersion: "env-v1",
            accessTokenExpiresAt: new Date(Date.now() + 60_000),
          },
        },
        permissions: {
          create: [
            {
              permission: "https://www.googleapis.com/auth/youtube.upload",
              status: "GRANTED",
            },
          ],
        },
        capabilities: {
          create: [
            {
              capability: "ACCOUNT_HEALTH_CHECK",
              enabled: true,
            },
          ],
        },
      },
      include: { tokens: true, permissions: true, capabilities: true },
    });
    const state = await db.socialOAuthState.create({
      data: {
        id: oauthStateId,
        workspaceId,
        channelId,
        userId,
        platform: "YOUTUBE",
        expectedRemoteAccountId: "UC-fixture",
        stateHash: `sha256-${randomUUID()}`,
        codeVerifierCiphertext: "pkce-ciphertext-fixture",
        codeVerifierNonce: "pkce-nonce-fixture",
        codeVerifierTag: "pkce-tag-fixture",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(account.tokens?.accessTokenCiphertext).toBe("ciphertext-fixture");
    expect(account.permissions[0]?.status).toBe("GRANTED");
    expect(account.capabilities[0]?.enabled).toBe(true);
    expect(state.consumedAt).toBeNull();
    expect(state.codeVerifierCiphertext).toBe("pkce-ciphertext-fixture");
  });

  it("rejects cross-workspace token references", async () => {
    if (!db) return;
    await db.socialAccount.create({
      data: {
        id: otherAccountId,
        workspaceId,
        channelId,
        platform: "YOUTUBE",
        remoteAccountId: "UC-other-fixture",
        displayName: "Other fixture channel",
      },
    });
    await expect(
      db.socialAccountToken.create({
        data: {
          workspaceId: otherWorkspaceId,
          socialAccountId: otherAccountId,
          accessTokenCiphertext: "ciphertext-fixture",
          accessTokenNonce: "nonce-fixture",
          accessTokenTag: "tag-fixture",
          encryptionKeyVersion: "env-v1",
          accessTokenExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
