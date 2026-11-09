import { createHash } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, type PrismaClient } from "@reelforge/database";
import {
  InstagramNotConfiguredConnector,
  YouTubeConnector,
  YOUTUBE_MINIMUM_SCOPES,
} from "@reelforge/social-providers";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import { SocialAccountsService } from "./social-accounts.service.js";
import { TokenVault } from "./token-vault.js";

const ownerContext = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  role: "OWNER" as const,
};
const viewerContext = { ...ownerContext, role: "VIEWER" as const };
const encryptionKey = Buffer.alloc(32, 9).toString("base64url");
const callbackUrl = "http://localhost:3001/social-accounts/oauth/YOUTUBE/callback";
const channelId = "00000000-0000-4000-8000-000000000003";

type FakeState = {
  id: string;
  workspaceId: string;
  channelId: string;
  userId: string;
  platform: "YOUTUBE" | "INSTAGRAM";
  expectedRemoteAccountId: string;
  stateHash: string;
  codeVerifierCiphertext: string;
  codeVerifierNonce: string;
  codeVerifierTag: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

type FakeAccount = {
  id: string;
  workspaceId: string;
  channelId: string;
  platform: "YOUTUBE" | "INSTAGRAM";
  remoteAccountId: string;
  displayName: string;
  username: string | null;
  status: "CONNECTED" | "REAUTH_REQUIRED" | "REVOCATION_PENDING" | "REVOCATION_FAILED" | "REVOKED";
  health: "HEALTHY" | "AUTH_REQUIRED" | "UNAVAILABLE";
  connectedAt: Date;
  lastHealthCheckAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  permissions: Array<{ permission: string; status: "GRANTED" | "NOT_GRANTED" }>;
  capabilities: Array<{
    capability: string;
    enabled: boolean;
    details: Record<string, unknown> | null;
    checkedAt: Date;
  }>;
};

type MockCall = { mock: { calls: unknown[][] } };

type AccountWhere = {
  workspaceId_id?: { workspaceId: string; id: string };
  workspaceId_channelId_platform_remoteAccountId?: {
    workspaceId: string;
    channelId: string;
    platform: "YOUTUBE" | "INSTAGRAM";
    remoteAccountId: string;
  };
};

type SocialAccountsHarness = {
  db: {
    socialOAuthState: { create: MockCall };
    socialAccount: { create: MockCall; findUnique: MockCall; update: MockCall };
    $transaction: MockCall;
  };
  tx: {
    socialAccount: { create: MockCall; update: MockCall };
    socialAccountToken: {
      create: MockCall;
      deleteMany: MockCall;
      upsert: MockCall;
    };
  };
  request: Mock<typeof fetch>;
  service: SocialAccountsService;
  getState: () => FakeState | null;
  getToken: () => Record<string, unknown> | null;
};

function fixtureFetch(identityId = "UC-fixture"): Mock<typeof fetch> {
  const responses = [
    new Response(
      JSON.stringify({
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: YOUTUBE_MINIMUM_SCOPES.join(" "),
      }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        items: [{ id: identityId, snippet: { title: "Fixture channel", customUrl: "@fixture" } }],
      }),
      { status: 200 },
    ),
  ];
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected provider request");
    return response;
  });
}

function createHarness(
  identityId = "UC-fixture",
  persistFailure: boolean | Error = false,
): SocialAccountsHarness {
  let state: FakeState | null = null;
  let account: FakeAccount | null = null;
  let token: Record<string, unknown> | null = null;
  const tx = {
    socialAccount: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            id: string;
            workspaceId: string;
            channelId: string;
            platform: "YOUTUBE" | "INSTAGRAM";
            remoteAccountId: string;
            displayName: string;
            username: string | null;
            status: FakeAccount["status"];
            health: FakeAccount["health"];
            lastHealthCheckAt: Date;
          };
        }) => {
          account = {
            ...data,
            connectedAt: new Date(),
            permissions: [],
            capabilities: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          return account;
        },
      ),
      update: vi.fn(async ({ data }: { data: Partial<FakeAccount> }) => {
        if (account === null) throw new Error("Missing account fixture");
        account = { ...account, ...data };
        return account;
      }),
      findUnique: vi.fn(async ({ where }: { where: AccountWhere }) => {
        const key = where.workspaceId_channelId_platform_remoteAccountId;
        if (
          key &&
          account?.workspaceId === key.workspaceId &&
          account.channelId === key.channelId &&
          account.platform === key.platform &&
          account.remoteAccountId === key.remoteAccountId
        ) {
          return account;
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async () => account),
    },
    socialAccountToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        token = data;
        return data;
      }),
      deleteMany: vi.fn(async () => {
        const count = token === null ? 0 : 1;
        token = null;
        return { count };
      }),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          token = token === null ? create : { ...token, ...update };
          return token;
        },
      ),
    },
    socialAccountPermission: {
      deleteMany: vi.fn(async () => {
        if (account !== null) account = { ...account, permissions: [] };
        return { count: 1 };
      }),
      createMany: vi.fn(async ({ data }: { data: FakeAccount["permissions"] }) => {
        if (account === null) throw new Error("Missing account fixture");
        account = { ...account, permissions: data };
        return { count: data.length };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { permission?: string };
          data: Partial<FakeAccount["permissions"][number]>;
        }) => {
          if (account === null) throw new Error("Missing account fixture");
          account = {
            ...account,
            permissions: account.permissions.map((permission) =>
              where.permission === undefined || permission.permission === where.permission
                ? { ...permission, ...data }
                : permission,
            ),
          };
          return { count: account.permissions.length };
        },
      ),
    },
    socialAccountCapability: {
      deleteMany: vi.fn(async () => {
        if (account !== null) account = { ...account, capabilities: [] };
        return { count: 1 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<FakeAccount["capabilities"][number]> }) => {
        if (account === null) throw new Error("Missing account fixture");
        account = { ...account, capabilities: data };
        return { count: data.length };
      }),
      updateMany: vi.fn(
        async ({ data }: { data: Partial<FakeAccount["capabilities"][number]> }) => {
          if (account === null) throw new Error("Missing account fixture");
          account = {
            ...account,
            capabilities: account.capabilities.map((capability) => ({ ...capability, ...data })),
          };
          return { count: account.capabilities.length };
        },
      ),
    },
  };
  const db = {
    channel: { findUnique: vi.fn().mockResolvedValue({ id: channelId, status: "ACTIVE" }) },
    socialOAuthState: {
      create: vi.fn(async ({ data }: { data: Omit<FakeState, "consumedAt"> }) => {
        state = { ...data, consumedAt: null };
        return state;
      }),
      findUnique: vi.fn(async () => state),
      updateMany: vi.fn(async () => {
        if (state === null || state.consumedAt !== null) return { count: 0 };
        state = { ...state, consumedAt: new Date() };
        return { count: 1 };
      }),
    },
    socialAccount: {
      create: vi.fn(),
      findUnique: vi.fn(async ({ where }: { where: AccountWhere }) => {
        const byId = where.workspaceId_id;
        const byIdentity = where.workspaceId_channelId_platform_remoteAccountId;
        return account !== null &&
          ((byId !== undefined &&
            account.workspaceId === byId.workspaceId &&
            account.id === byId.id) ||
            (byIdentity !== undefined &&
              account.workspaceId === byIdentity.workspaceId &&
              account.channelId === byIdentity.channelId &&
              account.platform === byIdentity.platform &&
              account.remoteAccountId === byIdentity.remoteAccountId))
          ? account
          : null;
      }),
      findMany: vi.fn(async () => (account ? [account] : [])),
      update: vi.fn(async ({ data }: { data: Partial<FakeAccount> }) => {
        if (account === null) throw new Error("Missing account fixture");
        account = { ...account, ...data };
        return account;
      }),
    },
    socialAccountToken: {
      findFirst: vi.fn(async () => token),
      create: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        token = { ...token, ...data };
        return token;
      }),
      deleteMany: vi.fn(async () => ({ count: token === null ? 0 : 1 })),
    },
    socialAccountPermission: {
      createMany: vi.fn(),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { permission?: string };
          data: Partial<FakeAccount["permissions"][number]>;
        }) => {
          if (account === null) throw new Error("Missing account fixture");
          account = {
            ...account,
            permissions: account.permissions.map((permission) =>
              where.permission === undefined || permission.permission === where.permission
                ? { ...permission, ...data }
                : permission,
            ),
          };
          return { count: account.permissions.length };
        },
      ),
    },
    socialAccountCapability: {
      createMany: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async <T>(callback: (transaction: typeof tx) => Promise<T>) => {
      if (persistFailure) {
        if (persistFailure instanceof Error) throw persistFailure;
        throw new Error("fixture persistence failure");
      }
      return callback(tx);
    }),
  };
  const request = fixtureFetch(identityId);
  const connector = new YouTubeConnector(
    { clientId: "fixture-client", clientSecret: "fixture-secret" },
    request,
  );
  const workspaces = {
    context: vi.fn().mockResolvedValue(ownerContext),
  };
  const service = new SocialAccountsService(
    db as unknown as PrismaClient,
    workspaces as unknown as WorkspaceService,
    connector,
    new InstagramNotConfiguredConnector(),
    new TokenVault(encryptionKey),
    callbackUrl,
  );
  return {
    db,
    tx,
    request,
    service,
    getState: (): FakeState | null => state,
    getToken: (): Record<string, unknown> | null => token,
  };
}

describe("SocialAccountsService", () => {
  it("creates one-time OAuth state with a state hash and encrypted PKCE verifier", async () => {
    const { db, service, getState } = createHarness();
    const result = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const url = new URL(result.authorizationUrl);
    const state = getState();

    expect(url.searchParams.get("state")).toHaveLength(43);
    expect(state?.stateHash).toBe(
      createHash("sha256")
        .update(url.searchParams.get("state") ?? "")
        .digest("hex"),
    );
    expect(state?.codeVerifierCiphertext).not.toContain("fixture");
    expect(state?.consumedAt).toBeNull();
    expect(db.socialOAuthState.create).toHaveBeenCalledOnce();
  });

  it("connects only the explicitly selected authenticated YouTube identity and never returns tokens", async () => {
    const { tx, service, request } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const account = await service.completeOAuth("YOUTUBE", {
      state: state ?? "",
      code: "fixture-authorization-code",
    });

    expect(account).toMatchObject({
      workspaceId: ownerContext.workspaceId,
      channelId,
      platform: "YOUTUBE",
      remoteAccountId: "UC-fixture",
      status: "CONNECTED",
      health: "HEALTHY",
    });
    expect(JSON.stringify(account)).not.toContain("fixture-access-token");
    expect(JSON.stringify(tx.socialAccountToken.upsert.mock.calls[0]?.[0])).not.toContain(
      "fixture-refresh-token",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("queries YouTube Analytics through the same authenticated token boundary", async () => {
    const { service, request } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const account = await service.completeOAuth("YOUTUBE", {
      state,
      code: "fixture-authorization-code",
    });
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            columnHeaders: [
              { name: "day", columnType: "DIMENSION", dataType: "STRING" },
              { name: "views", columnType: "METRIC", dataType: "INTEGER" },
            ],
            rows: [["2026-11-01", 7]],
          }),
          { status: 200 },
        ),
    );

    const client = await service.authenticatedClient(ownerContext, account.id);
    await expect(
      client.queryAnalytics({
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
        dimensions: ["day"],
      }),
    ).resolves.toMatchObject({ rows: [["2026-11-01", 7]] });
    const [url, init] = request.mock.calls[2] ?? [];
    expect(String(url)).toContain("youtubeanalytics.googleapis.com/v2/reports");
    expect(String(url)).toContain("ids=channel%3D%3DUC-fixture");
    expect(init?.headers).toEqual({ authorization: "Bearer fixture-access-token" });
  });

  it("rejects OAuth when the provider does not prove the minimum scopes", async () => {
    const { db, service, request } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fixture-access-token",
            refresh_token: "fixture-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );

    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.socialAccount.create).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain("/revoke");
    const revokeBody = request.mock.calls[1]?.[1]?.body;
    expect(revokeBody).toBeInstanceOf(URLSearchParams);
    expect((revokeBody as URLSearchParams).get("token")).toBe("fixture-refresh-token");
  });

  it("revokes the access token when the provider omits offline refresh access", async () => {
    const { service, request } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fixture-access-only",
            token_type: "Bearer",
            expires_in: 3600,
            scope: YOUTUBE_MINIMUM_SCOPES.join(" "),
          }),
          { status: 200 },
        ),
    );

    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toThrow("did not issue offline refresh access");
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain("/revoke");
    const revokeBody = request.mock.calls[1]?.[1]?.body;
    expect(revokeBody).toBeInstanceOf(URLSearchParams);
    expect((revokeBody as URLSearchParams).get("token")).toBe("fixture-access-only");
  });

  it("refreshes expiring credentials without persisting or returning plaintext tokens", async () => {
    const { service, request, getToken } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const account = await service.completeOAuth("YOUTUBE", {
      state,
      code: "fixture-authorization-code",
    });
    const refreshTokenExpiresAt = getToken()?.["refreshTokenExpiresAt"];
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fixture-refreshed-access",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );

    await service.refresh(ownerContext, account.id);
    const stored = JSON.stringify(getToken());
    expect(stored).not.toContain("fixture-refreshed-access");
    expect(stored).not.toContain("fixture-refresh-token");
    expect(stored).toContain("accessTokenCiphertext");
    expect(getToken()?.["refreshTokenExpiresAt"]).toEqual(refreshTokenExpiresAt);
  });

  it("checks account health through a read-only identity request and never uploads", async () => {
    const { service, request } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const account = await service.completeOAuth("YOUTUBE", {
      state,
      code: "fixture-authorization-code",
    });
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: "UC-fixture", snippet: { title: "Fixture channel" } }],
          }),
          { status: 200 },
        ),
    );

    await expect(service.checkHealth(ownerContext, account.id)).resolves.toMatchObject({
      health: "HEALTHY",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[0])).toContain("/youtube/v3/channels");
    expect(String(request.mock.calls[2]?.[0])).not.toContain("/upload/");
  });

  it("revokes remotely and erases encrypted credentials locally", async () => {
    const { tx, service, request, getToken } = createHarness();
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    const account = await service.completeOAuth("YOUTUBE", {
      state,
      code: "fixture-authorization-code",
    });
    request.mockImplementationOnce(async () => new Response(null, { status: 200 }));

    await expect(service.revoke(ownerContext, account.id)).resolves.toMatchObject({
      status: "REVOKED",
      health: "AUTH_REQUIRED",
    });
    expect(tx.socialAccountToken.deleteMany).toHaveBeenCalledOnce();
    expect(tx.socialAccountToken.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: ownerContext.workspaceId, socialAccountId: account.id },
    });
    expect(getToken()).toBeNull();
  });

  it("reconnects a revoked account using its original account id", async () => {
    const { service, request, getToken } = createHarness();
    const firstStart = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get("state") ?? "";
    const firstAccount = await service.completeOAuth("YOUTUBE", {
      state: firstState,
      code: "fixture-authorization-code",
    });
    const oldCiphertext = getToken()?.["accessTokenCiphertext"];
    request.mockImplementationOnce(async () => new Response(null, { status: 200 }));
    await service.revoke(ownerContext, firstAccount.id);

    request
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fixture-reconnected-access",
              refresh_token: "fixture-reconnected-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token_expires_in: 7200,
              scope: YOUTUBE_MINIMUM_SCOPES.join(" "),
            }),
            { status: 200 },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                { id: "UC-fixture", snippet: { title: "Reconnected channel", customUrl: "@new" } },
              ],
            }),
            { status: 200 },
          ),
      );
    const secondStart = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get("state") ?? "";
    const reconnected = await service.completeOAuth("YOUTUBE", {
      state: secondState,
      code: "fixture-reconnect-authorization-code",
    });

    expect(reconnected.id).toBe(firstAccount.id);
    expect(reconnected).toMatchObject({
      status: "CONNECTED",
      health: "HEALTHY",
      displayName: "Reconnected channel",
      username: "@new",
    });
    expect(getToken()?.["accessTokenCiphertext"]).not.toBe(oldCiphertext);
  });

  it("reconnects an account in REAUTH_REQUIRED using its original account id", async () => {
    const { service, request, getToken } = createHarness();
    const firstStart = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get("state") ?? "";
    const firstAccount = await service.completeOAuth("YOUTUBE", {
      state: firstState,
      code: "fixture-authorization-code",
    });
    const oldCiphertext = getToken()?.["accessTokenCiphertext"];
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ items: [{ id: "UC-changed", snippet: { title: "Other channel" } }] }),
          { status: 200 },
        ),
    );
    await expect(service.checkHealth(ownerContext, firstAccount.id)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    request
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fixture-reauth-access",
              refresh_token: "fixture-reauth-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token_expires_in: 7200,
              scope: YOUTUBE_MINIMUM_SCOPES.join(" "),
            }),
            { status: 200 },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              items: [{ id: "UC-fixture", snippet: { title: "Reauthorized channel" } }],
            }),
            { status: 200 },
          ),
      );
    const secondStart = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get("state") ?? "";
    const reconnected = await service.completeOAuth("YOUTUBE", {
      state: secondState,
      code: "fixture-reauth-authorization-code",
    });

    expect(reconnected.id).toBe(firstAccount.id);
    expect(reconnected).toMatchObject({ status: "CONNECTED", health: "HEALTHY" });
    expect(getToken()?.["accessTokenCiphertext"]).not.toBe(oldCiphertext);
  });

  it("rejects account identity mismatch and replayed OAuth state", async () => {
    const { db, service, request } = createHarness("UC-not-selected");
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toThrow("invalid, expired, or already used");
    expect(db.socialAccount.create).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[0])).toContain("/revoke");
    const revokeBody = request.mock.calls[2]?.[1]?.body;
    expect(revokeBody).toBeInstanceOf(URLSearchParams);
    expect((revokeBody as URLSearchParams).get("token")).toBe("fixture-refresh-token");
  });

  it("revokes issued credentials when account persistence fails", async () => {
    const { service, request } = createHarness("UC-fixture", true);
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toThrow("fixture persistence failure");
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[0])).toContain("/revoke");
    const revokeBody = request.mock.calls[2]?.[1]?.body;
    expect(revokeBody).toBeInstanceOf(URLSearchParams);
    expect((revokeBody as URLSearchParams).get("token")).toBe("fixture-refresh-token");
  });

  it("maps a concurrent unique-account conflict to 409 and revokes the issued grant", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint conflict", {
      code: "P2002",
      clientVersion: "7.10.1",
    });
    const { service, request } = createHarness("UC-fixture", conflict);
    const started = await service.startConnection(ownerContext, channelId, "YOUTUBE", {
      remoteAccountId: "UC-fixture",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    await expect(
      service.completeOAuth("YOUTUBE", { state, code: "fixture-authorization-code" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[2]?.[0])).toContain("/revoke");
  });

  it("denies viewers mutations and scopes account retrieval to the workspace", async () => {
    const { db, service } = createHarness();
    await expect(
      service.startConnection(viewerContext, channelId, "YOUTUBE", {
        remoteAccountId: "UC-fixture",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.refresh(viewerContext, "account-a")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.revoke(viewerContext, "account-a")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const otherWorkspaceId = "00000000-0000-4000-8000-000000000005";
    await expect(
      service.get({ ...ownerContext, workspaceId: otherWorkspaceId }, "account-a"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.socialAccount.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: otherWorkspaceId, id: "account-a" } },
      include: { permissions: true, capabilities: true },
    });
  });

  it("fails closed for Instagram instead of fabricating an account", async () => {
    const { db, service } = createHarness();
    await expect(
      service.startConnection(ownerContext, channelId, "INSTAGRAM", {
        remoteAccountId: "fixture-ig-account",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.socialOAuthState.create).not.toHaveBeenCalled();
  });
});
