import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ChannelService } from "./channel.service.js";

@Controller("workspaces/:workspaceId/channels")
@UseGuards(AuthGuard)
export class ChannelController {
  public constructor(
    private readonly channels: ChannelService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
  @Get() public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.channels.list(await this.context(request, workspaceId));
  }
  @Post() public async create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.channels.create(await this.context(request, workspaceId), body);
  }
  @Get(":channelId") public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
  ): Promise<unknown> {
    return this.channels.get(await this.context(request, workspaceId), channelId);
  }
  @Patch(":channelId") public async update(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.channels.update(await this.context(request, workspaceId), channelId, body);
  }
  @Post(":channelId/status") public async status(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const status = (body as { status?: unknown })?.status;
    if (status !== "ACTIVE" && status !== "PAUSED" && status !== "ARCHIVED")
      throw new BadRequestException("status must be ACTIVE, PAUSED, or ARCHIVED");
    return this.channels.setStatus(await this.context(request, workspaceId), channelId, status);
  }
  @Post(":channelId/snapshots/:snapshotId/select") public async select(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Param("snapshotId") snapshotId: string,
  ): Promise<unknown> {
    return this.channels.selectSnapshot(
      await this.context(request, workspaceId),
      channelId,
      snapshotId,
    );
  }
}
