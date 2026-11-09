import type {
  SocialAccount,
  SocialPlatform,
  SocialPlatformError,
  YouTubeDestinationMetadata,
  YouTubePrivacyStatus,
} from "@reelforge/contracts";

export type OAuthAuthorizationRequest = Readonly<{
  state: string;
  codeChallenge: string;
  redirectUri: string;
}>;

export type OAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  refreshTokenExpiresInSeconds: number | null;
  scopes: readonly string[];
}>;

export type PlatformAccountIdentity = Readonly<{
  remoteAccountId: string;
  displayName: string;
  username: string | null;
}>;

export interface SocialPlatformConnector {
  readonly platform: SocialPlatform;
  readonly minimumScopes: readonly string[];
  isConfigured(): boolean;
  authorizationUrl(request: OAuthAuthorizationRequest): URL;
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokenSet>;
  identifyAccounts(accessToken: string): Promise<readonly PlatformAccountIdentity[]>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet>;
  revokeToken(token: string): Promise<void>;
}

export type YouTubeUploadProgress =
  | Readonly<{ completed: false; nextByte: number; videoId: null }>
  | Readonly<{ completed: true; nextByte: number; videoId: string }>;

export type VerifiedYouTubeVideo = Readonly<{
  videoId: string;
  channelId: string;
  title: string;
  privacyStatus: YouTubePrivacyStatus;
  uploadStatus: string;
  processingStatus: string | null;
}>;

export interface YouTubePublishingConnector extends SocialPlatformConnector {
  startVideoUpload(
    accessToken: string,
    metadata: YouTubeDestinationMetadata,
    totalBytes: number,
    contentType: string,
  ): Promise<string>;
  checkVideoUpload(
    accessToken: string,
    sessionUri: string,
    totalBytes: number,
  ): Promise<YouTubeUploadProgress>;
  uploadVideoChunk(
    accessToken: string,
    sessionUri: string,
    startByte: number,
    totalBytes: number,
    chunk: Uint8Array,
  ): Promise<YouTubeUploadProgress>;
  verifyUploadedVideo(
    accessToken: string,
    videoId: string,
    channelId: string,
    metadata: YouTubeDestinationMetadata,
  ): Promise<VerifiedYouTubeVideo>;
}

export type AuthenticatedPlatformClient = Readonly<{
  account: SocialAccount;
  checkHealth(): Promise<SocialAccount>;
  refresh(): Promise<SocialAccount>;
  startVideoUpload(
    metadata: YouTubeDestinationMetadata,
    totalBytes: number,
    contentType: string,
  ): Promise<string>;
  checkVideoUpload(sessionUri: string, totalBytes: number): Promise<YouTubeUploadProgress>;
  uploadVideoChunk(
    sessionUri: string,
    startByte: number,
    totalBytes: number,
    chunk: Uint8Array,
  ): Promise<YouTubeUploadProgress>;
  verifyUploadedVideo(
    videoId: string,
    metadata: YouTubeDestinationMetadata,
  ): Promise<VerifiedYouTubeVideo>;
}>;

export class SocialProviderError extends Error {
  public constructor(public readonly detail: SocialPlatformError) {
    super(detail.message);
    this.name = "SocialProviderError";
  }
}

export type NormalizedUploadSession = Readonly<{
  sessionUri: string;
  remoteMediaId: string | null;
  expiresAt: string | null;
}>;

export function normalizeUploadSession(
  location: string,
  allowedHosts: readonly string[],
): NormalizedUploadSession {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: "INVALID_UPLOAD_SESSION",
      message: "The platform returned an invalid upload session URI.",
      retryAfterSeconds: null,
    });
  }
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: "INVALID_UPLOAD_SESSION",
      message: "The platform returned an upload session outside its trusted host.",
      retryAfterSeconds: null,
    });
  }
  return { sessionUri: url.toString(), remoteMediaId: null, expiresAt: null };
}

export function normalizeRemoteMediaId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: "INVALID_REMOTE_MEDIA_ID",
      message: "The platform returned an invalid remote media ID.",
      retryAfterSeconds: null,
    });
  }
  return value;
}
