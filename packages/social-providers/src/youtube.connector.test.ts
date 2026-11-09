import { describe, expect, it, vi } from "vitest";
import {
  normalizeRemoteMediaId,
  normalizeUploadSession,
  SocialProviderError,
  YouTubeConnector,
  YOUTUBE_MINIMUM_SCOPES,
} from "./index.js";

const configuration = {
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
};

describe("YouTubeConnector", () => {
  it("requests only upload and read-only identity scopes with state and PKCE", () => {
    const connector = new YouTubeConnector(configuration);
    const url = connector.authorizationUrl({
      state: "fixture-state",
      codeChallenge: "fixture-challenge",
      redirectUri: "http://localhost:3001/social-accounts/oauth/YOUTUBE/callback",
    });

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...YOUTUBE_MINIMUM_SCOPES]);
    expect(url.searchParams.get("state")).toBe("fixture-state");
    expect(url.searchParams.get("code_challenge")).toBe("fixture-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("proves channel identity through the authenticated channels.list endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { id: "UC-fixture", snippet: { title: "Fixture channel", customUrl: "@fixture" } },
          ],
        }),
        { status: 200 },
      ),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(connector.identifyAccounts("fixture-access-token")).resolves.toEqual([
      {
        remoteAccountId: "UC-fixture",
        displayName: "Fixture channel",
        username: "@fixture",
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = request.mock.calls[0] ?? [];
    expect(String(requestUrl)).toContain("youtube/v3/channels");
    expect(String(requestUrl)).toContain("mine=true");
    expect(requestInit?.headers).toEqual({ authorization: "Bearer fixture-access-token" });
  });

  it("does not infer granted scopes when Google omits them from the token response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
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
    const connector = new YouTubeConnector(configuration, request);

    await expect(
      connector.exchangeCode("fixture-code", "fixture-verifier", "https://example.test/callback"),
    ).resolves.toMatchObject({ scopes: [] });
  });

  it("normalizes permission failures without exposing provider response bodies", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "access_denied", error_description: "fixture secret" }),
        {
          status: 403,
        },
      ),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(connector.identifyAccounts("fixture-access-token")).rejects.toMatchObject({
      detail: {
        kind: "PERMISSION_DENIED",
        code: "access_denied",
        message: "YouTube denied the requested account permission.",
        retryAfterSeconds: null,
      },
    } satisfies Partial<SocialProviderError>);
  });

  it("normalizes documented quota/rate-limit responses", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            errors: [{ reason: "quotaExceeded" }],
          },
        }),
        { status: 403, headers: { "retry-after": "30" } },
      ),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(connector.identifyAccounts("fixture-access-token")).rejects.toMatchObject({
      detail: {
        kind: "RATE_LIMITED",
        code: "quotaExceeded",
        retryAfterSeconds: 30,
      },
    });
  });

  it("normalizes opaque upload references and rejects untrusted session origins", () => {
    expect(
      normalizeUploadSession(
        "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture",
        ["www.googleapis.com"],
      ),
    ).toMatchObject({
      sessionUri: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture",
      remoteMediaId: null,
    });
    expect(() =>
      normalizeUploadSession("https://attacker.example/session", ["www.googleapis.com"]),
    ).toThrow(SocialProviderError);
    expect(normalizeRemoteMediaId("video-fixture")).toBe("video-fixture");
    expect(() => normalizeRemoteMediaId("")).toThrow(SocialProviderError);
  });
});
