import { SocialPlatformErrorSchema, YouTubeAnalyticsReportSchema } from "@reelforge/contracts";
import type {
  SocialPlatformError,
  YouTubeAnalyticsReport,
  YouTubeDestinationMetadata,
  YouTubePrivacyStatus,
} from "@reelforge/contracts";
import {
  SocialProviderError,
  normalizeUploadSession,
  type OAuthAuthorizationRequest,
  type OAuthTokenSet,
  type PlatformAccountIdentity,
  type YouTubeAnalyticsQueryRequest,
  type YouTubePublishingConnector,
  type YouTubeUploadProgress,
  type VerifiedYouTubeVideo,
} from "./types.js";

export const YOUTUBE_MINIMUM_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revocationEndpoint = "https://oauth2.googleapis.com/revoke";
const channelsEndpoint = "https://www.googleapis.com/youtube/v3/channels";
const videosEndpoint = "https://www.googleapis.com/youtube/v3/videos";
const uploadEndpoint = "https://www.googleapis.com/upload/youtube/v3/videos";
const analyticsEndpoint = "https://youtubeanalytics.googleapis.com/v2/reports";
const uploadSessionHosts = ["www.googleapis.com"] as const;

export type YouTubeOAuthConfiguration = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function providerErrorCode(value: unknown): string | null {
  const direct = fieldString(value, "error");
  if (direct !== null) return direct;
  const outerError = isRecord(value) ? value["error"] : null;
  if (!isRecord(outerError)) return null;
  const status = fieldString(outerError, "status");
  if (status !== null) return status;
  const errors = outerError["errors"];
  const firstError = Array.isArray(errors) ? errors[0] : null;
  return fieldString(firstError, "reason");
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredRecord(value: unknown, code: string): JsonRecord {
  if (!isRecord(value)) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code,
      message: "YouTube returned an invalid video response.",
      retryAfterSeconds: null,
    });
  }
  return value;
}

function uploadProgress(response: Response, body: unknown): YouTubeUploadProgress {
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range === null ? null : /^bytes=0-(\d+)$/.exec(range);
    const lastUploadedByte = match?.[1] === undefined ? -1 : Number(match[1]);
    if (!Number.isSafeInteger(lastUploadedByte) || lastUploadedByte < -1) {
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_UPLOAD_RANGE",
        message: "YouTube returned an invalid resumable upload range.",
        retryAfterSeconds: null,
      });
    }
    return { completed: false, nextByte: lastUploadedByte + 1, videoId: null };
  }
  if (response.status !== 200 && response.status !== 201) {
    throw new SocialProviderError(normalizedFailure(response, body));
  }
  const videoId = fieldString(body, "id");
  if (videoId === null) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: "INVALID_UPLOAD_COMPLETION",
      message: "YouTube completed an upload without returning a video ID.",
      retryAfterSeconds: null,
    });
  }
  return { completed: true, nextByte: 0, videoId };
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : Math.max(1, Math.ceil((timestamp - Date.now()) / 1000));
}

function normalizedFailure(response: Response, body: unknown): SocialPlatformError {
  const providerCode = providerErrorCode(body);
  const code = providerCode?.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  const kind =
    response.status === 401 || code === "invalid_grant"
      ? "AUTH_REQUIRED"
      : response.status === 429 ||
          code === "quotaExceeded" ||
          code === "rateLimitExceeded" ||
          code === "userRateLimitExceeded"
        ? "RATE_LIMITED"
        : response.status === 403
          ? "PERMISSION_DENIED"
          : response.status >= 500
            ? "TRANSIENT"
            : "PERMANENT";
  const message =
    kind === "AUTH_REQUIRED"
      ? "YouTube authorization is no longer valid."
      : kind === "PERMISSION_DENIED"
        ? "YouTube denied the requested account permission."
        : kind === "RATE_LIMITED"
          ? "YouTube rate limit was reached."
          : kind === "TRANSIENT"
            ? "YouTube is temporarily unavailable."
            : "YouTube rejected the request.";
  return SocialPlatformErrorSchema.parse({
    kind,
    code: code ?? `HTTP_${response.status}`,
    message,
    retryAfterSeconds: retryAfterSeconds(response),
  });
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return null;
  }
}

function parseTokenSet(value: unknown, allowMissingScopes: boolean): OAuthTokenSet {
  const accessToken = fieldString(value, "access_token");
  const tokenType = fieldString(value, "token_type");
  const expiresInSeconds = isRecord(value) ? positiveInteger(value["expires_in"]) : null;
  const refreshToken = fieldString(value, "refresh_token");
  const refreshExpires = isRecord(value)
    ? positiveInteger(value["refresh_token_expires_in"])
    : null;
  const rawScopes = fieldString(value, "scope");
  const scopes =
    rawScopes === null && allowMissingScopes
      ? []
      : rawScopes === null
        ? null
        : rawScopes.split(/\s+/).filter((scope) => scope.length > 0);
  if (
    accessToken === null ||
    tokenType?.toLowerCase() !== "bearer" ||
    expiresInSeconds === null ||
    scopes === null
  ) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: "INVALID_TOKEN_RESPONSE",
      message: "Google returned an invalid OAuth token response.",
      retryAfterSeconds: null,
    });
  }
  return {
    accessToken,
    refreshToken,
    expiresInSeconds,
    refreshTokenExpiresInSeconds: refreshExpires,
    scopes,
  };
}

export class YouTubeConnector implements YouTubePublishingConnector {
  public readonly platform = "YOUTUBE" as const;
  public readonly minimumScopes = YOUTUBE_MINIMUM_SCOPES;

  public constructor(
    private readonly configuration: YouTubeOAuthConfiguration | null,
    private readonly request: typeof fetch = fetch,
  ) {}

  public isConfigured(): boolean {
    return (
      this.configuration !== null &&
      this.configuration.clientId.length > 0 &&
      this.configuration.clientSecret.length > 0
    );
  }

  public authorizationUrl(request: OAuthAuthorizationRequest): URL {
    const configuration = this.requireConfiguration();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("client_id", configuration.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.minimumScopes.join(" "));
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "false");
    return url;
  }

  public async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenSet> {
    const configuration = this.requireConfiguration();
    const response = await this.request(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await responseJson(response);
    if (!response.ok) throw new SocialProviderError(normalizedFailure(response, body));
    return parseTokenSet(body, true);
  }

  public async identifyAccounts(accessToken: string): Promise<readonly PlatformAccountIdentity[]> {
    const url = new URL(channelsEndpoint);
    url.searchParams.set("part", "id,snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await responseJson(response);
    if (!response.ok) throw new SocialProviderError(normalizedFailure(response, body));
    if (!isRecord(body) || !Array.isArray(body["items"])) {
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_CHANNEL_RESPONSE",
        message: "YouTube returned an invalid channel identity response.",
        retryAfterSeconds: null,
      });
    }
    return body["items"].map((item) => {
      const remoteAccountId = fieldString(item, "id");
      const snippet = isRecord(item) ? item["snippet"] : null;
      const displayName = fieldString(snippet, "title");
      if (remoteAccountId === null || displayName === null) {
        throw new SocialProviderError({
          kind: "PERMANENT",
          code: "INVALID_CHANNEL_IDENTITY",
          message: "YouTube returned an incomplete channel identity.",
          retryAfterSeconds: null,
        });
      }
      const customUrl = fieldString(snippet, "customUrl");
      return {
        remoteAccountId,
        displayName,
        username: customUrl,
      };
    });
  }

  public async refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet> {
    const configuration = this.requireConfiguration();
    const response = await this.request(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await responseJson(response);
    if (!response.ok) throw new SocialProviderError(normalizedFailure(response, body));
    return parseTokenSet(body, true);
  }

  public async revokeToken(token: string): Promise<void> {
    this.requireConfiguration();
    const response = await this.request(revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return;
    throw new SocialProviderError(normalizedFailure(response, await responseJson(response)));
  }

  public async queryAnalytics(
    accessToken: string,
    remoteAccountId: string,
    request: YouTubeAnalyticsQueryRequest,
  ): Promise<YouTubeAnalyticsReport> {
    if (remoteAccountId.length === 0 || request.metrics.length === 0) {
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_ANALYTICS_QUERY",
        message: "YouTube Analytics requires a channel identity and at least one metric.",
        retryAfterSeconds: null,
      });
    }
    const url = new URL(analyticsEndpoint);
    url.searchParams.set("ids", `channel==${remoteAccountId}`);
    url.searchParams.set("startDate", request.startDate);
    url.searchParams.set("endDate", request.endDate);
    url.searchParams.set("metrics", request.metrics.join(","));
    if (request.dimensions !== undefined && request.dimensions.length > 0)
      url.searchParams.set("dimensions", request.dimensions.join(","));
    if (request.filters !== undefined && request.filters.length > 0)
      url.searchParams.set("filters", request.filters.join(";"));
    if (request.maxResults !== undefined) {
      if (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1)
        throw new SocialProviderError({
          kind: "PERMANENT",
          code: "INVALID_ANALYTICS_QUERY",
          message: "YouTube Analytics maxResults must be a positive integer.",
          retryAfterSeconds: null,
        });
      url.searchParams.set("maxResults", String(request.maxResults));
    }
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await responseJson(response);
    if (!response.ok) throw new SocialProviderError(normalizedFailure(response, body));
    const parsed = YouTubeAnalyticsReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_ANALYTICS_RESPONSE",
        message: "YouTube returned an invalid Analytics report.",
        retryAfterSeconds: null,
      });
    }
    return parsed.data;
  }

  public async startVideoUpload(
    accessToken: string,
    metadata: YouTubeDestinationMetadata,
    totalBytes: number,
    contentType: string,
  ): Promise<string> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_UPLOAD_SIZE",
        message: "The video size is invalid for upload.",
        retryAfterSeconds: null,
      });
    const url = new URL(uploadEndpoint);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("part", "snippet,status");
    url.searchParams.set("notifySubscribers", "false");
    let response: Response;
    try {
      response = await this.request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-length": String(totalBytes),
          "x-upload-content-type": contentType,
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
            ...(metadata.categoryId === undefined ? {} : { categoryId: metadata.categoryId }),
          },
          status: {
            privacyStatus: metadata.privacyStatus,
            selfDeclaredMadeForKids: metadata.selfDeclaredMadeForKids,
          },
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw this.unknownUploadOutcome();
    }
    if (!response.ok)
      throw new SocialProviderError(normalizedFailure(response, await responseJson(response)));
    const location = response.headers.get("location");
    if (location === null) {
      throw new SocialProviderError({
        kind: "TRANSIENT",
        code: "UPLOAD_SESSION_MISSING",
        message: "YouTube did not return a resumable upload session.",
        retryAfterSeconds: null,
      });
    }
    return normalizeUploadSession(location, uploadSessionHosts).sessionUri;
  }

  public async checkVideoUpload(
    accessToken: string,
    sessionUri: string,
    totalBytes: number,
  ): Promise<YouTubeUploadProgress> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_UPLOAD_SIZE",
        message: "The video size is invalid for upload reconciliation.",
        retryAfterSeconds: null,
      });
    const safeSessionUri = normalizeUploadSession(sessionUri, uploadSessionHosts).sessionUri;
    let response: Response;
    try {
      response = await this.request(safeSessionUri, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-length": "0",
          "content-range": `bytes */${totalBytes}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw this.unknownUploadOutcome();
    }
    return uploadProgress(response, await responseJson(response));
  }

  public async uploadVideoChunk(
    accessToken: string,
    sessionUri: string,
    startByte: number,
    totalBytes: number,
    chunk: Uint8Array,
  ): Promise<YouTubeUploadProgress> {
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isSafeInteger(startByte) ||
      startByte < 0 ||
      chunk.byteLength === 0 ||
      startByte + chunk.byteLength > totalBytes
    )
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "INVALID_UPLOAD_CHUNK",
        message: "The video upload chunk has an invalid byte range.",
        retryAfterSeconds: null,
      });
    const safeSessionUri = normalizeUploadSession(sessionUri, uploadSessionHosts).sessionUri;
    const endByte = startByte + chunk.byteLength - 1;
    let response: Response;
    try {
      response = await this.request(safeSessionUri, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-length": String(chunk.byteLength),
          "content-range": `bytes ${startByte}-${endByte}/${totalBytes}`,
        },
        body: new Uint8Array(chunk),
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw this.unknownUploadOutcome();
    }
    return uploadProgress(response, await responseJson(response));
  }

  public async verifyUploadedVideo(
    accessToken: string,
    videoId: string,
    channelId: string,
    metadata: YouTubeDestinationMetadata,
  ): Promise<VerifiedYouTubeVideo> {
    const url = new URL(videosEndpoint);
    url.searchParams.set("part", "id,snippet,status,processingDetails");
    url.searchParams.set("id", videoId);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await responseJson(response);
    if (!response.ok) throw new SocialProviderError(normalizedFailure(response, body));
    const root = requiredRecord(body, "INVALID_VIDEO_VERIFICATION");
    const items = root["items"];
    const resource =
      Array.isArray(items) && items.length === 1 ? requiredRecord(items[0], "INVALID_VIDEO") : null;
    const id = fieldString(resource, "id");
    const snippet = resource?.["snippet"];
    const status = resource?.["status"];
    const processingDetails = resource?.["processingDetails"];
    const returnedChannelId = fieldString(snippet, "channelId");
    const title = fieldString(snippet, "title");
    const description = fieldString(snippet, "description");
    const categoryId = fieldString(snippet, "categoryId");
    const rawTags = isRecord(snippet) ? snippet["tags"] : null;
    const tagsMatch =
      metadata.tags === undefined
        ? rawTags === undefined || (Array.isArray(rawTags) && rawTags.length === 0)
        : Array.isArray(rawTags) &&
          rawTags.length === metadata.tags.length &&
          rawTags.every((tag, index) => tag === metadata.tags?.[index]);
    const privacyStatus = fieldString(status, "privacyStatus");
    const uploadStatus = fieldString(status, "uploadStatus");
    const processingStatus = fieldString(processingDetails, "processingStatus");
    const selfDeclaredMadeForKids = isRecord(status)
      ? status["selfDeclaredMadeForKids"]
      : undefined;
    if (
      id !== videoId ||
      returnedChannelId !== channelId ||
      title !== metadata.title ||
      description !== metadata.description ||
      (metadata.categoryId !== undefined && categoryId !== metadata.categoryId) ||
      !tagsMatch ||
      privacyStatus !== metadata.privacyStatus ||
      selfDeclaredMadeForKids !== metadata.selfDeclaredMadeForKids ||
      (privacyStatus !== "private" && privacyStatus !== "unlisted" && privacyStatus !== "public") ||
      uploadStatus === null
    ) {
      throw new SocialProviderError({
        kind: "PERMANENT",
        code: "UPLOAD_RESULT_MISMATCH",
        message: "The uploaded video did not match the requested channel and metadata.",
        retryAfterSeconds: null,
      });
    }
    return {
      videoId: id,
      channelId: returnedChannelId,
      title,
      privacyStatus: privacyStatus as YouTubePrivacyStatus,
      uploadStatus,
      processingStatus,
    };
  }

  private unknownUploadOutcome(): SocialProviderError {
    return new SocialProviderError({
      kind: "TRANSIENT",
      code: "UPLOAD_OUTCOME_UNKNOWN",
      message:
        "The YouTube upload outcome is unknown; reconcile the resumable session before retrying.",
      retryAfterSeconds: null,
    });
  }

  private requireConfiguration(): YouTubeOAuthConfiguration {
    const configuration = this.configuration;
    if (
      configuration === null ||
      configuration.clientId.length === 0 ||
      configuration.clientSecret.length === 0
    ) {
      throw new SocialProviderError({
        kind: "NOT_CONFIGURED",
        code: "YOUTUBE_NOT_CONFIGURED",
        message: "YouTube account connection is not configured.",
        retryAfterSeconds: null,
      });
    }
    return configuration;
  }
}
