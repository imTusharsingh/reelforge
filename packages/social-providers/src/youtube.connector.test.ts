import { describe, expect, it, vi } from "vitest";
import {
  normalizeRemoteMediaId,
  normalizeUploadSession,
  SocialProviderError,
  YouTubeConnector,
  YOUTUBE_MINIMUM_SCOPES,
} from "./index.js";
import type { YouTubeDestinationMetadata } from "@reelforge/contracts";

const configuration = {
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
};
const uploadMetadata: YouTubeDestinationMetadata = {
  platform: "YOUTUBE",
  title: "Fixture upload",
  description: "Fixture description",
  tags: ["fixture"],
  categoryId: "22",
  privacyStatus: "private",
  selfDeclaredMadeForKids: false,
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

  it("queries authenticated YouTube Analytics reports for the selected channel", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: [
            { name: "day", columnType: "DIMENSION", dataType: "STRING" },
            { name: "views", columnType: "METRIC", dataType: "INTEGER" },
          ],
          rows: [["2026-11-01", 12]],
        }),
        { status: 200 },
      ),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(
      connector.queryAnalytics("fixture-access-token", "UC-fixture", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
        dimensions: ["day"],
      }),
    ).resolves.toMatchObject({ rows: [["2026-11-01", 12]] });
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toContain("youtubeanalytics.googleapis.com/v2/reports");
    expect(String(url)).toContain("ids=channel%3D%3DUC-fixture");
    expect(String(url)).toContain("metrics=views");
    expect(init?.headers).toEqual({ authorization: "Bearer fixture-access-token" });
  });

  it("treats omitted or null Analytics rows as an empty report", async () => {
    const omittedRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: [
            { name: "day", columnType: "DIMENSION", dataType: "STRING" },
            { name: "views", columnType: "METRIC", dataType: "INTEGER" },
          ],
        }),
        { status: 200 },
      ),
    );
    const omittedConnector = new YouTubeConnector(configuration, omittedRequest);
    await expect(
      omittedConnector.queryAnalytics("fixture-access-token", "UC-fixture", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
        dimensions: ["day"],
      }),
    ).resolves.toMatchObject({ rows: [] });

    const nullRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: [
            { name: "day", columnType: "DIMENSION", dataType: "STRING" },
            { name: "views", columnType: "METRIC", dataType: "INTEGER" },
          ],
          rows: null,
        }),
        { status: 200 },
      ),
    );
    const nullConnector = new YouTubeConnector(configuration, nullRequest);
    await expect(
      nullConnector.queryAnalytics("fixture-access-token", "UC-fixture", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
        dimensions: ["day"],
      }),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("fails closed on invalid Analytics responses and rate limits", async () => {
    const invalidRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    const invalidConnector = new YouTubeConnector(configuration, invalidRequest);
    await expect(
      invalidConnector.queryAnalytics("fixture-access-token", "UC-fixture", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
      }),
    ).rejects.toMatchObject({
      detail: { kind: "PERMANENT", code: "INVALID_ANALYTICS_RESPONSE" },
    });

    const limitedRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
        status: 403,
        headers: { "retry-after": "45" },
      }),
    );
    const limitedConnector = new YouTubeConnector(configuration, limitedRequest);
    await expect(
      limitedConnector.queryAnalytics("fixture-access-token", "UC-fixture", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        metrics: ["views"],
      }),
    ).rejects.toMatchObject({
      detail: { kind: "RATE_LIMITED", code: "quotaExceeded", retryAfterSeconds: 45 },
    });
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

  it("starts a private resumable upload and validates the returned session origin", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture",
        },
      }),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(
      connector.startVideoUpload("fixture-token", uploadMetadata, 1024, "video/mp4"),
    ).resolves.toBe("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture");
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toContain("uploadType=resumable");
    expect(String(url)).toContain("part=snippet%2Cstatus");
    expect(init?.headers).toMatchObject({
      "x-upload-content-length": "1024",
      "x-upload-content-type": "video/mp4",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      snippet: {
        title: "Fixture upload",
        description: "Fixture description",
        tags: ["fixture"],
        categoryId: "22",
      },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    });
  });

  it("reconciles an interrupted session and returns the acknowledged upload offset", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: "bytes=0-524287" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "fixture-video" }), { status: 201 }),
      );
    const connector = new YouTubeConnector(configuration, request);
    const sessionUri = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture";

    await expect(
      connector.checkVideoUpload("fixture-token", sessionUri, 1_048_576),
    ).resolves.toEqual({ completed: false, nextByte: 524_288, videoId: null });
    await expect(
      connector.uploadVideoChunk(
        "fixture-token",
        sessionUri,
        524_288,
        1_048_576,
        new Uint8Array(524_288),
      ),
    ).resolves.toEqual({ completed: true, nextByte: 0, videoId: "fixture-video" });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      "content-range": "bytes */1048576",
    });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      "content-range": "bytes 524288-1048575/1048576",
    });
  });

  it("verifies the inserted video against the selected channel and destination metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "fixture-video",
              snippet: {
                channelId: "UC-fixture",
                title: uploadMetadata.title,
                description: uploadMetadata.description,
                tags: uploadMetadata.tags,
                categoryId: uploadMetadata.categoryId,
              },
              status: {
                privacyStatus: "private",
                uploadStatus: "uploaded",
                selfDeclaredMadeForKids: uploadMetadata.selfDeclaredMadeForKids,
              },
              processingDetails: { processingStatus: "processing" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const connector = new YouTubeConnector(configuration, request);

    await expect(
      connector.verifyUploadedVideo("fixture-token", "fixture-video", "UC-fixture", uploadMetadata),
    ).resolves.toEqual({
      videoId: "fixture-video",
      channelId: "UC-fixture",
      title: uploadMetadata.title,
      privacyStatus: "private",
      uploadStatus: "uploaded",
      processingStatus: "processing",
    });
    expect(String(request.mock.calls[0]?.[0])).toContain(
      "part=id%2Csnippet%2Cstatus%2CprocessingDetails",
    );
  });

  it("fails closed on an unknown upload outcome and mismatched verified video", async () => {
    const failedRequest = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("fixture network error"));
    const failedConnector = new YouTubeConnector(configuration, failedRequest);
    await expect(
      failedConnector.startVideoUpload("fixture-token", uploadMetadata, 1024, "video/mp4"),
    ).rejects.toMatchObject({
      detail: {
        kind: "TRANSIENT",
        code: "UPLOAD_OUTCOME_UNKNOWN",
      },
    });

    const mismatchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "fixture-video",
              snippet: {
                channelId: "UC-other",
                title: uploadMetadata.title,
                description: uploadMetadata.description,
                tags: uploadMetadata.tags,
                categoryId: uploadMetadata.categoryId,
              },
              status: {
                privacyStatus: "public",
                uploadStatus: "uploaded",
                selfDeclaredMadeForKids: uploadMetadata.selfDeclaredMadeForKids,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const mismatchConnector = new YouTubeConnector(configuration, mismatchRequest);
    await expect(
      mismatchConnector.verifyUploadedVideo(
        "fixture-token",
        "fixture-video",
        "UC-fixture",
        uploadMetadata,
      ),
    ).rejects.toMatchObject({
      detail: { kind: "PERMANENT", code: "UPLOAD_RESULT_MISMATCH" },
    });
  });
});
