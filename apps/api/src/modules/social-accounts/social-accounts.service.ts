import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  SocialAccountSchema,
  type SocialAccount,
  type SocialPlatform,
  type SocialPlatformError,
} from "@reelforge/contracts";
import { Prisma, type PrismaClient } from "@reelforge/database";
import {
  SocialProviderError,
  YouTubeConnector,
  type AuthenticatedPlatformClient,
  type OAuthTokenSet,
  type SocialPlatformConnector,
} from "@reelforge/social-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { TokenVault, type EncryptedSecret } from "./token-vault.js";
import type { OAuthCallbackQuery, StartConnectionRequest } from "./social-accounts.validation.js";

export type OAuthReturnCode =
  | "STATE_INVALID"
  | "STATE_EXPIRED"
  | "ACCESS_DENIED"
  | "PLATFORM_NOT_CONFIGURED"
  | "EXCHANGE_FAILED";
export class OAuthReturnError extends BadRequestException {
  public constructor(
    public readonly returnCode: OAuthReturnCode,
    message: string,
  ) {
    super(message);
  }
}

const editableRoles = new Set(["OWNER", "EDITOR"]);
const stateLifetimeMs = 10 * 60 * 1000;
const refreshLeewayMs = 60 * 1000;
const requiredYoutubeCapabilities = [
  "ACCOUNT_IDENTITY_READ",
  "ACCOUNT_HEALTH_CHECK",
  "VIDEO_UPLOAD",
  "RESUMABLE_UPLOAD",
] as const;

type AccountRecord = Prisma.SocialAccountGetPayload<{
  include: { permissions: true; capabilities: true };
}>;
type TokenRecord = Prisma.SocialAccountTokenGetPayload<Record<string, never>>;
type EncryptedTokenFields = Pick<
  Prisma.SocialAccountTokenUncheckedCreateInput,
  | "accessTokenCiphertext"
  | "accessTokenNonce"
  | "accessTokenTag"
  | "refreshTokenCiphertext"
  | "refreshTokenNonce"
  | "refreshTokenTag"
  | "encryptionKeyVersion"
  | "accessTokenExpiresAt"
  | "refreshTokenExpiresAt"
>;

@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger(SocialAccountsService.name);

  public constructor(
    @Inject("DATABASE") private readonly db: PrismaClient,
    private readonly workspaces: WorkspaceService,
    private readonly youtube: YouTubeConnector,
    @Inject("INSTAGRAM_CONNECTOR")
    private readonly instagram: SocialPlatformConnector,
    private readonly vault: TokenVault,
    @Inject("YOUTUBE_OAUTH_CALLBACK_URL")
    private readonly callbackUrl: string | undefined,
  ) {}

  public youtubeConfigured(): boolean {
    return this.youtube.isConfigured();
  }

  public async startConnection(
    context: WorkspaceContext,
    channelId: string,
    platform: SocialPlatform,
    request: StartConnectionRequest,
  ): Promise<{ authorizationUrl: string }> {
    this.requireEditor(context);
    const channel = await this.db.channel.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: channelId } },
      select: { id: true, status: true },
    });
    if (!channel || channel.status === "ARCHIVED") throw new NotFoundException("Channel not found");

    const connector = this.connector(platform);
    const callbackUrl = this.requireCallbackUrl();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const stateId = randomUUID();
    const encryptedVerifier = this.vault.encrypt(
      verifier,
      `${context.workspaceId}:${stateId}:pkce`,
    );
    const expiresAt = new Date(Date.now() + stateLifetimeMs);
    const authorizationUrl = connector.authorizationUrl({
      state,
      codeChallenge,
      redirectUri: callbackUrl,
    });

    await this.db.socialOAuthState.create({
      data: {
        id: stateId,
        workspaceId: context.workspaceId,
        channelId,
        userId: context.userId,
        platform,
        expectedRemoteAccountId: request.remoteAccountId,
        stateHash: this.hashState(state),
        codeVerifierCiphertext: encryptedVerifier.ciphertext,
        codeVerifierNonce: encryptedVerifier.nonce,
        codeVerifierTag: encryptedVerifier.tag,
        expiresAt,
      },
    });
    return { authorizationUrl: authorizationUrl.toString() };
  }

  public async completeOAuth(
    platform: SocialPlatform,
    query: OAuthCallbackQuery,
  ): Promise<SocialAccount> {
    const state = await this.db.socialOAuthState.findUnique({
      where: { stateHash: this.hashState(query.state) },
    });
    const now = new Date();
    if (!state || state.platform !== platform || state.consumedAt !== null) {
      throw new OAuthReturnError(
        "STATE_INVALID",
        "OAuth state is invalid, expired, or already used",
      );
    }
    if (state.expiresAt <= now)
      throw new OAuthReturnError(
        "STATE_EXPIRED",
        "OAuth state is invalid, expired, or already used",
      );
    const claimed = await this.db.socialOAuthState.updateMany({
      where: { id: state.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1)
      throw new OAuthReturnError("STATE_INVALID", "OAuth state was already used");
    if (query.error !== undefined)
      throw new OAuthReturnError("ACCESS_DENIED", "Platform authorization was denied");

    const context = await this.workspaces.context(state.userId, state.workspaceId);
    this.requireEditor(context);
    if (!this.platformAdapter(platform).isConfigured())
      throw new OAuthReturnError("PLATFORM_NOT_CONFIGURED", "Platform is not configured");
    const connector = this.connector(platform);
    const encryptedVerifier: EncryptedSecret = {
      ciphertext: state.codeVerifierCiphertext,
      nonce: state.codeVerifierNonce,
      tag: state.codeVerifierTag,
      keyVersion: "env-v1",
    };
    const verifier = this.vault.decrypt(encryptedVerifier, `${state.workspaceId}:${state.id}:pkce`);
    const tokenSet = await this.callProvider(() =>
      connector.exchangeCode(query.code ?? "", verifier, this.requireCallbackUrl()),
    );
    try {
      this.requireScopes(connector, tokenSet.scopes);
      if (tokenSet.refreshToken === null)
        throw new BadGatewayException("YouTube did not issue offline refresh access");
      const identities = await this.callProvider(() =>
        connector.identifyAccounts(tokenSet.accessToken),
      );
      const identity = identities.find(
        (candidate) => candidate.remoteAccountId === state.expectedRemoteAccountId,
      );
      if (!identity)
        throw new ConflictException("Authenticated account did not match the selected account");

      const accessTokenId = randomUUID();
      const account = await this.db.$transaction(async (tx) => {
        const existing = await tx.socialAccount.findUnique({
          where: {
            workspaceId_channelId_platform_remoteAccountId: {
              workspaceId: state.workspaceId,
              channelId: state.channelId,
              platform,
              remoteAccountId: identity.remoteAccountId,
            },
          },
          include: { permissions: true, capabilities: true },
        });
        const id = existing?.id ?? accessTokenId;
        const accountData = {
          displayName: identity.displayName,
          username: identity.username,
          status: "CONNECTED" as const,
          health: "HEALTHY" as const,
          connectedAt: now,
          lastHealthCheckAt: now,
        };
        if (existing) {
          await tx.socialAccount.update({
            where: { workspaceId_id: { workspaceId: state.workspaceId, id } },
            data: accountData,
          });
        } else {
          await tx.socialAccount.create({
            data: {
              id,
              workspaceId: state.workspaceId,
              channelId: state.channelId,
              platform,
              remoteAccountId: identity.remoteAccountId,
              ...accountData,
            },
          });
        }
        await tx.socialAccountToken.upsert({
          where: { socialAccountId: id },
          create: {
            workspaceId: state.workspaceId,
            socialAccountId: id,
            ...this.encryptTokens(tokenSet, state.workspaceId, id),
          },
          update: this.encryptTokens(tokenSet, state.workspaceId, id),
        });
        await tx.socialAccountPermission.deleteMany({
          where: { workspaceId: state.workspaceId, socialAccountId: id },
        });
        await tx.socialAccountPermission.createMany({
          data: connector.minimumScopes.map((permission) => ({
            workspaceId: state.workspaceId,
            socialAccountId: id,
            permission,
            status: tokenSet.scopes.includes(permission) ? "GRANTED" : "NOT_GRANTED",
          })),
        });
        await tx.socialAccountCapability.deleteMany({
          where: { workspaceId: state.workspaceId, socialAccountId: id },
        });
        await tx.socialAccountCapability.createMany({
          data: this.capabilityRows(state.workspaceId, id, tokenSet.scopes, now),
        });
        return this.toView(
          await tx.socialAccount.findUniqueOrThrow({
            where: { workspaceId_id: { workspaceId: state.workspaceId, id } },
            include: { permissions: true, capabilities: true },
          }),
        );
      });
      return account;
    } catch (error) {
      try {
        await connector.revokeToken(tokenSet.refreshToken ?? tokenSet.accessToken);
      } catch {
        this.logger.error(
          `Best-effort ${platform} token revocation failed after OAuth completion failure.`,
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          "Social account connection conflicted with an existing account",
        );
      }
      throw error;
    }
  }

  public async list(context: WorkspaceContext): Promise<SocialAccount[]> {
    const accounts = await this.db.socialAccount.findMany({
      where: { workspaceId: context.workspaceId },
      include: { permissions: true, capabilities: true },
      orderBy: { connectedAt: "desc" },
    });
    return accounts.map((account) => this.toView(account));
  }

  public async get(context: WorkspaceContext, accountId: string): Promise<SocialAccount> {
    return this.toView(await this.findAccount(context.workspaceId, accountId));
  }

  public async refresh(context: WorkspaceContext, accountId: string): Promise<SocialAccount> {
    this.requireEditor(context);
    const account = await this.findAccount(context.workspaceId, accountId);
    if (account.status !== "CONNECTED")
      throw new ConflictException("Social account is not connected");
    const credentials = await this.findToken(context.workspaceId, accountId);
    const refreshToken = this.decryptRefreshToken(credentials, context.workspaceId, accountId);
    const connector = this.connector(account.platform);
    let refreshed: OAuthTokenSet;
    try {
      refreshed = await connector.refreshAccessToken(refreshToken);
    } catch (error) {
      if (error instanceof SocialProviderError && error.detail.kind === "AUTH_REQUIRED") {
        await this.markReauthRequired(context.workspaceId, accountId);
      }
      if (error instanceof SocialProviderError) this.throwProvider(error.detail);
      throw error;
    }
    const grantedScopes =
      refreshed.scopes.length > 0
        ? refreshed.scopes
        : account.permissions
            .filter((permission) => permission.status === "GRANTED")
            .map((permission) => permission.permission);
    if (!connector.minimumScopes.every((scope) => grantedScopes.includes(scope))) {
      await this.markReauthRequired(context.workspaceId, accountId);
      throw new ForbiddenException("The account no longer grants the minimum required permissions");
    }
    const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
    const encryptedTokens = this.encryptTokens(
      { ...refreshed, refreshToken: nextRefreshToken },
      context.workspaceId,
      accountId,
    );
    await this.db.socialAccountToken.update({
      where: { socialAccountId: accountId },
      data: {
        ...encryptedTokens,
        refreshTokenExpiresAt:
          refreshed.refreshToken === null && refreshed.refreshTokenExpiresInSeconds === null
            ? credentials.refreshTokenExpiresAt
            : (encryptedTokens.refreshTokenExpiresAt ?? null),
      },
    });
    if (refreshed.scopes.length > 0) {
      await this.db.$transaction(async (tx) => {
        await tx.socialAccountPermission.updateMany({
          where: { workspaceId: context.workspaceId, socialAccountId: accountId },
          data: { status: "NOT_GRANTED" },
        });
        await Promise.all(
          grantedScopes.map((permission) =>
            tx.socialAccountPermission.updateMany({
              where: { workspaceId: context.workspaceId, socialAccountId: accountId, permission },
              data: { status: "GRANTED", recordedAt: new Date() },
            }),
          ),
        );
      });
    }
    return this.get(context, accountId);
  }

  public async checkHealth(context: WorkspaceContext, accountId: string): Promise<SocialAccount> {
    this.requireEditor(context);
    const account = await this.findAccount(context.workspaceId, accountId);
    if (account.status !== "CONNECTED")
      throw new ConflictException("Social account is not connected");
    const credentials = await this.findToken(context.workspaceId, accountId);
    const accessToken = await this.validAccessToken(context, account, credentials);
    const connector = this.connector(account.platform);
    try {
      const identities = await connector.identifyAccounts(accessToken);
      if (!identities.some((candidate) => candidate.remoteAccountId === account.remoteAccountId)) {
        await this.markReauthRequired(context.workspaceId, accountId);
        throw new UnauthorizedException("Connected platform account identity has changed");
      }
      await this.db.socialAccount.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: accountId } },
        data: { health: "HEALTHY", lastHealthCheckAt: new Date() },
      });
    } catch (error) {
      if (error instanceof SocialProviderError) {
        if (error.detail.kind === "AUTH_REQUIRED") {
          await this.markReauthRequired(context.workspaceId, accountId);
        } else {
          await this.db.socialAccount.update({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: accountId } },
            data: { health: "UNAVAILABLE", lastHealthCheckAt: new Date() },
          });
        }
        this.throwProvider(error.detail);
      }
      throw error;
    }
    return this.get(context, accountId);
  }

  public async revoke(context: WorkspaceContext, accountId: string): Promise<SocialAccount> {
    this.requireEditor(context);
    const account = await this.findAccount(context.workspaceId, accountId);
    if (account.status === "REVOKED") return this.toView(account);
    const connector = this.platformAdapter(account.platform);
    await this.db.socialAccount.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: accountId } },
      data: { status: "REVOCATION_PENDING" },
    });
    let remoteRevoked = false;
    try {
      const credentials = await this.findToken(context.workspaceId, accountId);
      const token =
        credentials.refreshTokenCiphertext === null
          ? this.decryptAccessToken(credentials, context.workspaceId, accountId)
          : this.decryptRefreshToken(credentials, context.workspaceId, accountId);
      if (!connector.isConfigured())
        this.throwProvider({
          kind: "NOT_CONFIGURED",
          code:
            account.platform === "YOUTUBE" ? "YOUTUBE_NOT_CONFIGURED" : "INSTAGRAM_NOT_CONFIGURED",
          message: "Platform revocation is not configured; local credentials were removed.",
          retryAfterSeconds: null,
        });
      await this.callProvider(() => connector.revokeToken(token));
      remoteRevoked = true;
    } finally {
      await this.db.$transaction(async (tx) => {
        await tx.socialAccountToken.deleteMany({
          where: { workspaceId: context.workspaceId, socialAccountId: accountId },
        });
        await tx.socialAccountCapability.updateMany({
          where: { workspaceId: context.workspaceId, socialAccountId: accountId },
          data: { enabled: false, checkedAt: new Date() },
        });
        await tx.socialAccount.update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: accountId } },
          data: {
            status: remoteRevoked ? "REVOKED" : "REVOCATION_FAILED",
            health: "AUTH_REQUIRED",
          },
        });
      });
    }
    return this.get(context, accountId);
  }

  public async authenticatedClient(
    context: WorkspaceContext,
    accountId: string,
  ): Promise<AuthenticatedPlatformClient> {
    const account = await this.get(context, accountId);
    if (account.status !== "CONNECTED")
      throw new ConflictException("Social account is not connected");
    return {
      account,
      checkHealth: () => this.checkHealth(context, accountId),
      refresh: () => this.refresh(context, accountId),
      startVideoUpload: (metadata, totalBytes, contentType) =>
        this.withYouTubeUpload(context, accountId, "RESUMABLE_UPLOAD", (connector, accessToken) =>
          connector.startVideoUpload(accessToken, metadata, totalBytes, contentType),
        ),
      checkVideoUpload: (sessionUri, totalBytes) =>
        this.withYouTubeUpload(context, accountId, "RESUMABLE_UPLOAD", (connector, accessToken) =>
          connector.checkVideoUpload(accessToken, sessionUri, totalBytes),
        ),
      uploadVideoChunk: (sessionUri, startByte, totalBytes, chunk) =>
        this.withYouTubeUpload(context, accountId, "RESUMABLE_UPLOAD", (connector, accessToken) =>
          connector.uploadVideoChunk(accessToken, sessionUri, startByte, totalBytes, chunk),
        ),
      verifyUploadedVideo: (videoId, metadata) =>
        this.withYouTubeUpload(context, accountId, "VIDEO_UPLOAD", (connector, accessToken) =>
          connector.verifyUploadedVideo(accessToken, videoId, account.remoteAccountId, metadata),
        ),
      queryAnalytics: (request) =>
        this.withYouTubeAnalytics(context, accountId, (connector, accessToken) =>
          connector.queryAnalytics(accessToken, account.remoteAccountId, request),
        ),
    };
  }

  private async withYouTubeAnalytics<T>(
    context: WorkspaceContext,
    accountId: string,
    operation: (connector: YouTubeConnector, accessToken: string) => Promise<T>,
  ): Promise<T> {
    const account = await this.findAccount(context.workspaceId, accountId);
    if (account.platform !== "YOUTUBE")
      throw new ConflictException("YouTube Analytics is only supported for YouTube accounts");
    if (account.status !== "CONNECTED")
      throw new ConflictException("YouTube account is not connected");
    if (account.health !== "HEALTHY")
      throw new ConflictException("YouTube account health must be healthy to read Analytics");
    const readScope = "https://www.googleapis.com/auth/youtube.readonly";
    if (
      !account.permissions.some(
        (permission) => permission.permission === readScope && permission.status === "GRANTED",
      )
    )
      throw new ForbiddenException("The YouTube account does not grant the read-only scope");
    const connector = this.youtube;
    if (!connector.isConfigured())
      this.throwProvider({
        kind: "NOT_CONFIGURED",
        code: "YOUTUBE_NOT_CONFIGURED",
        message: "YouTube Analytics is not configured.",
        retryAfterSeconds: null,
      });
    const credentials = await this.findToken(context.workspaceId, accountId);
    const accessToken = await this.validAccessToken(context, account, credentials);
    return this.callProvider(() => operation(connector, accessToken));
  }

  private async withYouTubeUpload<T>(
    context: WorkspaceContext,
    accountId: string,
    capability: "VIDEO_UPLOAD" | "RESUMABLE_UPLOAD",
    operation: (connector: YouTubeConnector, accessToken: string) => Promise<T>,
  ): Promise<T> {
    const account = await this.findAccount(context.workspaceId, accountId);
    if (account.platform !== "YOUTUBE")
      throw new ConflictException("Video uploads are only supported for YouTube accounts");
    if (account.status !== "CONNECTED")
      throw new ConflictException("YouTube account is not connected");
    if (account.health !== "HEALTHY")
      throw new ConflictException("YouTube account health must be healthy to publish");
    const uploadScope = "https://www.googleapis.com/auth/youtube.upload";
    if (
      !account.permissions.some(
        (permission) => permission.permission === uploadScope && permission.status === "GRANTED",
      )
    )
      throw new ForbiddenException("The YouTube account does not grant the upload scope");
    const allowed = account.capabilities.some((item) => {
      if (item.capability !== capability || !item.enabled || item.details === null) return false;
      return (
        typeof item.details === "object" &&
        !Array.isArray(item.details) &&
        item.details["executionImplemented"] === true
      );
    });
    if (!allowed)
      throw new ServiceUnavailableException(`YouTube capability ${capability} is unavailable`);
    const connector = this.youtube;
    if (!connector.isConfigured())
      this.throwProvider({
        kind: "NOT_CONFIGURED",
        code: "YOUTUBE_NOT_CONFIGURED",
        message: "YouTube publishing is not configured.",
        retryAfterSeconds: null,
      });
    const credentials = await this.findToken(context.workspaceId, accountId);
    const accessToken = await this.validAccessToken(context, account, credentials);
    return this.callProvider(() => operation(connector, accessToken));
  }

  private async validAccessToken(
    context: WorkspaceContext,
    account: AccountRecord,
    credentials: TokenRecord,
  ): Promise<string> {
    if (credentials.accessTokenExpiresAt.getTime() > Date.now() + refreshLeewayMs)
      return this.decryptAccessToken(credentials, context.workspaceId, account.id);
    await this.refresh(context, account.id);
    return this.decryptAccessToken(
      await this.findToken(context.workspaceId, account.id),
      context.workspaceId,
      account.id,
    );
  }

  private async findAccount(workspaceId: string, accountId: string): Promise<AccountRecord> {
    const account = await this.db.socialAccount.findUnique({
      where: { workspaceId_id: { workspaceId, id: accountId } },
      include: { permissions: true, capabilities: true },
    });
    if (!account) throw new NotFoundException("Social account not found");
    return account;
  }

  private async findToken(workspaceId: string, accountId: string): Promise<TokenRecord> {
    const token = await this.db.socialAccountToken.findFirst({
      where: { workspaceId, socialAccountId: accountId },
    });
    if (!token) throw new ConflictException("Social account credentials are unavailable");
    return token;
  }

  private async markReauthRequired(workspaceId: string, accountId: string): Promise<void> {
    const checkedAt = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.socialAccount.update({
        where: { workspaceId_id: { workspaceId, id: accountId } },
        data: {
          status: "REAUTH_REQUIRED",
          health: "AUTH_REQUIRED",
          lastHealthCheckAt: checkedAt,
        },
      });
      await tx.socialAccountCapability.updateMany({
        where: { workspaceId, socialAccountId: accountId },
        data: { enabled: false, checkedAt },
      });
    });
  }

  private decryptAccessToken(token: TokenRecord, workspaceId: string, accountId: string): string {
    return this.vault.decrypt(this.encryptedSecret(token), `${workspaceId}:${accountId}:access`);
  }

  private decryptRefreshToken(token: TokenRecord, workspaceId: string, accountId: string): string {
    if (
      token.refreshTokenCiphertext === null ||
      token.refreshTokenNonce === null ||
      token.refreshTokenTag === null
    )
      throw new ConflictException("Social account requires reconnection");
    return this.vault.decrypt(
      {
        ciphertext: token.refreshTokenCiphertext,
        nonce: token.refreshTokenNonce,
        tag: token.refreshTokenTag,
        keyVersion: this.keyVersion(token),
      },
      `${workspaceId}:${accountId}:refresh`,
    );
  }

  private encryptedSecret(token: TokenRecord): EncryptedSecret {
    return {
      ciphertext: token.accessTokenCiphertext,
      nonce: token.accessTokenNonce,
      tag: token.accessTokenTag,
      keyVersion: this.keyVersion(token),
    };
  }

  private keyVersion(token: TokenRecord): "env-v1" {
    if (token.encryptionKeyVersion !== "env-v1")
      throw new ServiceUnavailableException("Unsupported social token encryption key version");
    return "env-v1";
  }

  private encryptTokens(
    tokenSet: OAuthTokenSet,
    workspaceId: string,
    accountId: string,
  ): EncryptedTokenFields {
    const access = this.vault.encrypt(tokenSet.accessToken, `${workspaceId}:${accountId}:access`);
    const refresh =
      tokenSet.refreshToken === null
        ? null
        : this.vault.encrypt(tokenSet.refreshToken, `${workspaceId}:${accountId}:refresh`);
    const now = new Date();
    return {
      accessTokenCiphertext: access.ciphertext,
      accessTokenNonce: access.nonce,
      accessTokenTag: access.tag,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenNonce: refresh?.nonce ?? null,
      refreshTokenTag: refresh?.tag ?? null,
      encryptionKeyVersion: access.keyVersion,
      accessTokenExpiresAt: new Date(now.getTime() + tokenSet.expiresInSeconds * 1000),
      refreshTokenExpiresAt:
        tokenSet.refreshTokenExpiresInSeconds === null
          ? null
          : new Date(now.getTime() + tokenSet.refreshTokenExpiresInSeconds * 1000),
    };
  }

  private capabilityRows(
    workspaceId: string,
    socialAccountId: string,
    scopes: readonly string[],
    checkedAt: Date,
  ): Prisma.SocialAccountCapabilityCreateManyInput[] {
    const uploadGranted = scopes.includes("https://www.googleapis.com/auth/youtube.upload");
    return requiredYoutubeCapabilities.map((capability) => ({
      workspaceId,
      socialAccountId,
      capability,
      enabled:
        capability === "VIDEO_UPLOAD" || capability === "RESUMABLE_UPLOAD" ? uploadGranted : true,
      details: {
        platformOperation: capability === "VIDEO_UPLOAD" ? "YouTube Data API videos.insert" : null,
        executionImplemented: capability === "VIDEO_UPLOAD" || capability === "RESUMABLE_UPLOAD",
        checkedAt: checkedAt.toISOString(),
      },
      checkedAt,
    }));
  }

  private toView(account: AccountRecord): SocialAccount {
    return SocialAccountSchema.parse({
      id: account.id,
      workspaceId: account.workspaceId,
      channelId: account.channelId,
      platform: account.platform,
      remoteAccountId: account.remoteAccountId,
      displayName: account.displayName,
      username: account.username,
      status: account.status,
      health: account.health,
      connectedAt: account.connectedAt.toISOString(),
      lastHealthCheckAt: account.lastHealthCheckAt?.toISOString() ?? null,
      permissions: account.permissions.map((permission) => ({
        permission: permission.permission,
        status: permission.status,
      })),
      capabilities: account.capabilities.map((capability) => ({
        capability: capability.capability,
        enabled: capability.enabled,
        details:
          capability.details !== null &&
          typeof capability.details === "object" &&
          !Array.isArray(capability.details)
            ? capability.details
            : null,
        checkedAt: capability.checkedAt.toISOString(),
      })),
    });
  }

  private connector(platform: SocialPlatform): SocialPlatformConnector {
    const connector = this.platformAdapter(platform);
    if (!connector.isConfigured())
      this.throwProvider({
        kind: "NOT_CONFIGURED",
        code: platform === "YOUTUBE" ? "YOUTUBE_NOT_CONFIGURED" : "INSTAGRAM_NOT_CONFIGURED",
        message:
          platform === "YOUTUBE"
            ? "YouTube account connection is not configured."
            : "Instagram account connection is not configured.",
        retryAfterSeconds: null,
      });
    return connector;
  }

  private platformAdapter(platform: SocialPlatform): SocialPlatformConnector {
    return platform === "YOUTUBE" ? this.youtube : this.instagram;
  }

  private requireCallbackUrl(): string {
    const candidate = this.callbackUrl;
    if (candidate === undefined || candidate.length === 0)
      throw new ServiceUnavailableException("YouTube OAuth callback is not configured");
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new ServiceUnavailableException("YouTube OAuth callback URL is invalid");
    }
    const localHttp =
      url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (!localHttp && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    )
      throw new ServiceUnavailableException("YouTube OAuth callback URL must use HTTPS");
    return url.toString();
  }

  private requireScopes(
    connector: SocialPlatformConnector,
    grantedScopes: readonly string[],
  ): void {
    if (!connector.minimumScopes.every((scope) => grantedScopes.includes(scope)))
      throw new ForbiddenException("The account did not grant the minimum required permissions");
  }

  private hashState(state: string): string {
    return createHash("sha256").update(state, "utf8").digest("hex");
  }

  private requireEditor(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Editor permission required");
  }

  private async callProvider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SocialProviderError) this.throwProvider(error.detail);
      throw error;
    }
  }

  private throwProvider(detail: SocialPlatformError): never {
    const status =
      detail.kind === "NOT_CONFIGURED"
        ? 503
        : detail.kind === "AUTH_REQUIRED"
          ? 401
          : detail.kind === "PERMISSION_DENIED"
            ? 403
            : detail.kind === "RATE_LIMITED"
              ? 429
              : detail.kind === "TRANSIENT"
                ? 502
                : 400;
    const exception =
      status === 401
        ? new UnauthorizedException(detail)
        : status === 403
          ? new ForbiddenException(detail)
          : status === 429
            ? new HttpException(detail, 429)
            : status === 503
              ? new ServiceUnavailableException(detail)
              : status === 502
                ? new BadGatewayException(detail)
                : new HttpException(detail, status);
    throw exception;
  }
}
