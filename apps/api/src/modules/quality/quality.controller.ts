import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { QualityService } from "./quality.service.js";
import type { QualityRenderStatusView, QualityRunView } from "./quality.types.js";

@Controller("workspaces/:workspaceId/quality")
@UseGuards(AuthGuard)
export class QualityController {
  public constructor(
    private readonly quality: QualityService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Post("runs")
  public async create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<QualityRunView> {
    return this.quality.create(await this.context(request, workspaceId), body);
  }

  @Get("queue")
  public async queue(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<QualityRunView[]> {
    return this.quality.queue(await this.context(request, workspaceId));
  }

  @Get("runs/:runId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<QualityRunView> {
    return this.quality.get(await this.context(request, workspaceId), runId);
  }

  @Get("renders/:renderJobId/status")
  public async getRenderStatus(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("renderJobId") renderJobId: string,
  ): Promise<QualityRenderStatusView> {
    return this.quality.getRenderQualityStatus(
      await this.context(request, workspaceId),
      renderJobId,
    );
  }

  @Post("runs/:runId/decision")
  public async decide(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
    @Body() body: unknown,
  ): Promise<QualityRunView> {
    return this.quality.decide(await this.context(request, workspaceId), runId, body);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
