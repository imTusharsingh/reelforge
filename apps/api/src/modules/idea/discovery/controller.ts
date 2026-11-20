import { BadRequestException, Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard, type AuthenticatedRequest } from "../../identity/auth.guard.js";
import { WorkspaceService } from "../../workspace/workspace.service.js";
import { DiscoveryStore } from "./store.js";
import type { LearnedChange } from "@reelforge/contracts";

@Controller("workspaces/:workspaceId/channels/:channelId/learning")
@UseGuards(AuthGuard)
export class DiscoveryController {
  public constructor(
    private readonly store: DiscoveryStore,
    private readonly workspaces: WorkspaceService,
  ) {}
  @Get()
  public async changes(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
  ): Promise<LearnedChange[]> {
    if (!z.uuid().safeParse(channelId).success) throw new BadRequestException("Invalid channel id");
    const context = await this.workspaces.context(request.principal.userId, workspaceId);
    return this.store.changes(context, channelId);
  }
}
