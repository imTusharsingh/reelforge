import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { PublishingService } from "./publishing.service.js";
import type { PublishedPostExport, ScheduledPostView } from "./publishing.types.js";

@Controller("workspaces/:workspaceId/publishing")
@UseGuards(AuthGuard)
export class PublishingController {
  public constructor(
    private readonly publishing: PublishingService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("platforms")
  public async platforms(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<ReturnType<PublishingService["platforms"]>> {
    await this.context(request, workspaceId);
    return this.publishing.platforms();
  }

  @Get("posts/:postId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("postId") postId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.getScheduledPost(await this.context(request, workspaceId), postId);
  }

  @Get("published-records")
  public async publishedRecords(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query("after") after?: string,
    @Query("afterId") afterId?: string,
    @Query("limit") limitText?: string,
  ): Promise<PublishedPostExport[]> {
    const limit = limitText === undefined ? 100 : Number(limitText);
    return this.publishing.listPublishedRecords(
      await this.context(request, workspaceId),
      after ?? null,
      limit,
      afterId ?? null,
    );
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
