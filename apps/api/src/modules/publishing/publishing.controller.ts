import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { PublishingService } from "./publishing.service.js";
import type {
  PublishingPreflightView,
  PublishedPostExport,
  ScheduledPostView,
} from "./publishing.types.js";

@Controller("workspaces/:workspaceId/publishing")
@UseGuards(AuthGuard)
export class PublishingController {
  public constructor(
    private readonly publishing: PublishingService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Post("posts")
  public async create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<ScheduledPostView> {
    return this.publishing.createScheduledPost(await this.context(request, workspaceId), body);
  }

  @Get("calendar")
  public async calendar(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query("from") from: string,
    @Query("to") to: string,
  ): Promise<ScheduledPostView[]> {
    return this.publishing.listCalendar(await this.context(request, workspaceId), from, to);
  }

  @Get("posts/:postId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("postId") postId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.getScheduledPost(await this.context(request, workspaceId), postId);
  }

  @Patch("posts/:postId")
  public async update(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("postId") postId: string,
    @Body() body: unknown,
  ): Promise<ScheduledPostView> {
    return this.publishing.updateScheduledPost(
      await this.context(request, workspaceId),
      postId,
      body,
    );
  }

  @Post("posts/:postId/cancel")
  public async cancel(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("postId") postId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.cancelScheduledPost(await this.context(request, workspaceId), postId);
  }

  @Get("destinations/:destinationId/preflight")
  public async preflight(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("destinationId") destinationId: string,
  ): Promise<PublishingPreflightView> {
    return this.publishing.preflight(await this.context(request, workspaceId), destinationId);
  }

  @Post("destinations/:destinationId/publish")
  public async publishNow(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("destinationId") destinationId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.publishNow(await this.context(request, workspaceId), destinationId);
  }

  @Post("destinations/:destinationId/retry")
  public async retry(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("destinationId") destinationId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.retry(await this.context(request, workspaceId), destinationId);
  }

  @Post("destinations/:destinationId/reconcile")
  public async reconcile(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("destinationId") destinationId: string,
  ): Promise<ScheduledPostView> {
    return this.publishing.reconcile(await this.context(request, workspaceId), destinationId);
  }

  @Post("posts/:postId/reschedule")
  public async reschedule(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("postId") postId: string,
    @Body() body: unknown,
  ): Promise<ScheduledPostView> {
    const scheduledAt =
      typeof body === "object" && body !== null && "scheduledAt" in body
        ? body.scheduledAt
        : undefined;
    if (scheduledAt === undefined || (scheduledAt !== null && typeof scheduledAt !== "string"))
      throw new BadRequestException("scheduledAt must be an ISO timestamp or null");
    return this.publishing.reschedule(
      await this.context(request, workspaceId),
      postId,
      scheduledAt,
    );
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
