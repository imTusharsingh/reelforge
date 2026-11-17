import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { SceneMediaService } from "./scene-media.service.js";

/** @deprecated M09 sync/still-image endpoints deleted in V5; C3 assignment replaced by V8 reshoot and deleted in T2. See DEPRECATIONS.md. */
@Controller("workspaces/:workspaceId/scene-media")
@UseGuards(AuthGuard)
export class SceneMediaController {
  public constructor(
    private readonly media: SceneMediaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("provider-health/:providerId/:capabilityId")
  public providerHealth(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
    @Param("capabilityId") capabilityId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.providerHealth(context, providerId, capabilityId),
    );
  }

  @Get("jobs")
  public list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.list(context, query));
  }

  @Get("capabilities")
  public capabilities(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.capabilities(context));
  }

  @Get("jobs/:jobId")
  public get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.get(context, jobId));
  }

  @Get("jobs/:jobId/export")
  public exportPackage(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.exportPackage(context, jobId),
    );
  }

  @Post("jobs/:jobId/scenes/:sceneId/assign-asset")
  public assignAsset(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("sceneId") sceneId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.assignAsset(context, jobId, sceneId, body),
    );
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
