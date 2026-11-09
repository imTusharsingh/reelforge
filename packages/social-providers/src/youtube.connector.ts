import { SocialPlatformErrorSchema } from "@reelforge/contracts";
import type { SocialPlatformError } from "@reelforge/contracts";
import {
  SocialProviderError,
  type OAuthAuthorizationRequest,
  type OAuthTokenSet,
  type PlatformAccountIdentity,
  type SocialPlatformConnector,
} from "./types.js";

export const YOUTUBE_MINIMUM_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revocationEndpoint = "https://oauth2.googleapis.com/revoke";
const channelsEndpoint = "https://www.googleapis.com/youtube/v3/channels";

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

export class YouTubeConnector implements SocialPlatformConnector {
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
