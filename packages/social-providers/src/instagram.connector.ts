import { SocialPlatformErrorSchema } from "@reelforge/contracts";
import {
  SocialProviderError,
  type OAuthTokenSet,
  type PlatformAccountIdentity,
  type SocialPlatformConnector,
} from "./types.js";

const notConfigured = (): SocialProviderError =>
  new SocialProviderError(
    SocialPlatformErrorSchema.parse({
      kind: "NOT_CONFIGURED",
      code: "INSTAGRAM_NOT_CONFIGURED",
      message: "Instagram account connection is not configured.",
      retryAfterSeconds: null,
    }),
  );

export class InstagramNotConfiguredConnector implements SocialPlatformConnector {
  public readonly platform = "INSTAGRAM" as const;
  public readonly minimumScopes: readonly string[] = [];

  public isConfigured(): boolean {
    return false;
  }

  public authorizationUrl(): URL {
    throw notConfigured();
  }

  public async exchangeCode(): Promise<OAuthTokenSet> {
    throw notConfigured();
  }

  public async identifyAccounts(): Promise<readonly PlatformAccountIdentity[]> {
    throw notConfigured();
  }

  public async refreshAccessToken(): Promise<OAuthTokenSet> {
    throw notConfigured();
  }

  public async revokeToken(): Promise<void> {
    throw notConfigured();
  }
}
