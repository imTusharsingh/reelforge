import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { OrchestrationService } from "./orchestration.service.js";
import type { WorkflowRunView } from "./orchestration.types.js";

@Controller("workspaces/:workspaceId/orchestration")
@UseGuards(AuthGuard)
export class OrchestrationController {
  public constructor(
    private readonly orchestration: OrchestrationService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Post("runs")
  public async start(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<WorkflowRunView> {
    return this.orchestration.startManualRun(await this.context(request, workspaceId), body);
  }

  @Get("runs")
  public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<WorkflowRunView[]> {
    return this.orchestration.listRuns(await this.context(request, workspaceId));
  }

  @Get("runs/:runId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<WorkflowRunView> {
    return this.orchestration.getRun(await this.context(request, workspaceId), runId);
  }

  @Post("runs/:runId/cancel")
  public async cancel(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<WorkflowRunView> {
    return this.orchestration.cancelRun(await this.context(request, workspaceId), runId);
  }

  @Post("runs/:runId/retry")
  public async retry(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<WorkflowRunView> {
    return this.orchestration.retryFromFailedStep(await this.context(request, workspaceId), runId);
  }

  @Post("runs/:runId/resume")
  public async resume(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<WorkflowRunView> {
    return this.orchestration.resumeRun(await this.context(request, workspaceId), runId);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
