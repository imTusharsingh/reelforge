import {
  Body,
  Controller,
  Get,
  Head,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  parseDownloadQuery,
  sendMediaContent,
  singleHeaderValue,
} from "../asset/content-delivery.js";
import { CompositionService } from "./composition.service.js";
import type { RenderJobView } from "./composition.types.js";
import type { RenderManifest } from "./composition.manifest.js";
@Controller("workspaces/:workspaceId/composition")
@UseGuards(AuthGuard)
export class CompositionController {
  public constructor(
    private readonly composition: CompositionService,
    private readonly workspaces: WorkspaceService,
  ) {}
  @Post("jobs") public create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<RenderJobView> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.create(context, body),
    );
  }
  @Get("jobs/:jobId") public get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<RenderJobView> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.get(context, jobId),
    );
  }
  @Get("jobs/:jobId/manifest") public manifest(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<RenderManifest> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.getManifest(context, jobId),
    );
  }
  @Post("jobs/:jobId/retry") public retry(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ): Promise<RenderJobView> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.retry(context, jobId, body),
    );
  }
  @Post("jobs/:jobId/cancel") public cancel(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<RenderJobView> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.cancel(context, jobId),
    );
  }
  @Post("jobs/:jobId/edit") public edit(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ): Promise<RenderJobView> {
    return this.context(request, workspaceId).then((context) =>
      this.composition.edit(context, jobId, body),
    );
  }

  @Get("jobs/:jobId/artifacts/:artifactId/content") public artifactContent(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("artifactId") artifactId: string,
    @Query("download") download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    return this.context(request, workspaceId).then(async (context) => {
      const content = await this.composition.getArtifactContent(context, jobId, artifactId);
      sendMediaContent(response, content, {
        download: parseDownloadQuery(download),
        rangeHeader: singleHeaderValue(request.headers.range),
        ifRangeHeader: singleHeaderValue(request.headers["if-range"]),
      });
    });
  }

  @Head("jobs/:jobId/artifacts/:artifactId/content") public artifactContentHead(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("artifactId") artifactId: string,
    @Query("download") download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    return this.context(request, workspaceId).then(async (context) => {
      const content = await this.composition.getArtifactContent(context, jobId, artifactId);
      sendMediaContent(response, content, {
        download: parseDownloadQuery(download),
        head: true,
      });
    });
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
