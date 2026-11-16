import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { BriefService } from "./brief.service.js";

@Controller("workspaces/:workspaceId/channels/:channelId/briefs")
@UseGuards(AuthGuard)
export class BriefController {
  public constructor(
    private readonly briefs: BriefService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get()
  public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
  ): Promise<unknown> {
    return this.briefs.list(
      await this.workspaces.context(request.principal.userId, workspaceId),
      channelId,
    );
  }

  @Get("eligibility")
  public async eligibility(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
  ): Promise<unknown> {
    return this.briefs.eligibility(
      await this.workspaces.context(request.principal.userId, workspaceId),
      channelId,
    );
  }

  @Post()
  public async create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.briefs.create(
      await this.workspaces.context(request.principal.userId, workspaceId),
      channelId,
      body,
    );
  }
}
