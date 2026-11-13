import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { SocialAccount } from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { OAuthReturnError, SocialAccountsService } from "./social-accounts.service.js";
import {
  parseOAuthCallback,
  parsePlatform,
  parseStartConnection,
} from "./social-accounts.validation.js";

@Controller("workspaces/:workspaceId")
@UseGuards(AuthGuard)
export class SocialAccountsController {
  public constructor(
    private readonly socialAccounts: SocialAccountsService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Post("channels/:channelId/social-accounts/:platform/connect")
  public async connect(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Param("platform") platform: string,
    @Body() body: unknown,
  ): Promise<{ authorizationUrl: string }> {
    return this.socialAccounts.startConnection(
      await this.context(request, workspaceId),
      channelId,
      parsePlatform(platform),
      parseStartConnection(body),
    );
  }

  @Get("social-accounts")
  public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<SocialAccount[]> {
    return this.socialAccounts.list(await this.context(request, workspaceId));
  }

  @Get("social-accounts/:accountId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
  ): Promise<SocialAccount> {
    return this.socialAccounts.get(await this.context(request, workspaceId), accountId);
  }

  @Post("social-accounts/:accountId/refresh")
  public async refresh(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
  ): Promise<SocialAccount> {
    return this.socialAccounts.refresh(await this.context(request, workspaceId), accountId);
  }

  @Post("social-accounts/:accountId/revoke")
  public async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
  ): Promise<SocialAccount> {
    return this.socialAccounts.revoke(await this.context(request, workspaceId), accountId);
  }

  @Post("social-accounts/:accountId/health")
  public async checkHealth(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("accountId") accountId: string,
  ): Promise<SocialAccount> {
    return this.socialAccounts.checkHealth(await this.context(request, workspaceId), accountId);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}

@Controller("social-accounts/oauth")
export class SocialOAuthCallbackController {
  public constructor(private readonly socialAccounts: SocialAccountsService) {}

  @Get(":platform/callback")
  public async callback(
    @Param("platform") platform: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SocialAccount | void> {
    const origin = process.env.WEB_APP_ORIGIN;
    if (!origin)
      return this.socialAccounts.completeOAuth(parsePlatform(platform), parseOAuthCallback(query));
    const url = new URL("/publishing/accounts", origin);
    try {
      let parsedPlatform: ReturnType<typeof parsePlatform>;
      let parsedQuery: ReturnType<typeof parseOAuthCallback>;
      try {
        parsedPlatform = parsePlatform(platform);
        parsedQuery = parseOAuthCallback(query);
      } catch {
        throw new OAuthReturnError("STATE_INVALID", "Invalid OAuth callback");
      }
      const account = await this.socialAccounts.completeOAuth(parsedPlatform, parsedQuery);
      url.searchParams.set("connected", account.id);
    } catch (error) {
      const code = error instanceof OAuthReturnError ? error.returnCode : "EXCHANGE_FAILED";
      url.searchParams.set("oauthError", code);
    }
    response.redirect(302, url.toString());
  }
}
