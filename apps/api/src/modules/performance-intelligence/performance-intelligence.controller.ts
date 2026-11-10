import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  type PerformanceExperiment,
  type PerformanceInsightReport,
  type PerformanceKpiDefinition,
  type PerformanceRecommendation,
  type PerformanceStrategyChange,
} from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { PerformanceIntelligenceService } from "./performance-intelligence.service.js";
import {
  parseCreateExperimentRequest,
  parseExportStrategyChangeRequest,
  parseGenerateInsightReportRequest,
  parseGenerateRecommendationsRequest,
  parsePerformanceChannelQuery,
  parsePerformanceId,
  parseRecordExperimentOutcomeRequest,
} from "./performance-intelligence.validation.js";

@Controller("workspaces/:workspaceId/performance-intelligence")
@UseGuards(AuthGuard)
export class PerformanceIntelligenceController {
  public constructor(
    private readonly performance: PerformanceIntelligenceService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("kpis")
  public async kpis(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<readonly PerformanceKpiDefinition[]> {
    await this.context(request, workspaceId);
    return this.performance.kpiDefinitions();
  }

  @Post("reports")
  public async generateReport(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<PerformanceInsightReport> {
    const context = await this.context(request, workspaceId);
    return this.performance.generateInsightReport(context, parseGenerateInsightReportRequest(body));
  }

  @Get("reports")
  public async listReports(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<PerformanceInsightReport[]> {
    const context = await this.context(request, workspaceId);
    return this.performance.listInsightReports(
      context,
      parsePerformanceChannelQuery(query).channelId,
    );
  }

  @Get("reports/:reportId")
  public async getReport(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("reportId") reportId: string,
  ): Promise<PerformanceInsightReport> {
    const context = await this.context(request, workspaceId);
    return this.performance.getInsightReport(context, parsePerformanceId(reportId));
  }

  @Post("reports/:reportId/recommendations")
  public async generateRecommendations(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("reportId") reportId: string,
    @Body() body: unknown,
  ): Promise<PerformanceRecommendation[]> {
    const context = await this.context(request, workspaceId);
    const parsed = parseGenerateRecommendationsRequest(body);
    const parsedReportId = parsePerformanceId(reportId);
    if (parsed.reportId !== parsedReportId)
      throw new BadRequestException("reportId in body must match the route parameter");
    return this.performance.generateRecommendations(context, parsedReportId);
  }

  @Get("recommendations")
  public async listRecommendations(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<PerformanceRecommendation[]> {
    const context = await this.context(request, workspaceId);
    return this.performance.listRecommendations(
      context,
      parsePerformanceChannelQuery(query).channelId,
    );
  }

  @Post("recommendations/:recommendationId/approve")
  public async approveRecommendation(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("recommendationId") recommendationId: string,
  ): Promise<PerformanceRecommendation> {
    const context = await this.context(request, workspaceId);
    return this.performance.approveRecommendation(context, parsePerformanceId(recommendationId));
  }

  @Post("experiments")
  public async createExperiment(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<PerformanceExperiment> {
    const context = await this.context(request, workspaceId);
    return this.performance.createExperiment(context, parseCreateExperimentRequest(body));
  }

  @Post("experiments/:experimentId/outcome")
  public async recordExperimentOutcome(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("experimentId") experimentId: string,
    @Body() body: unknown,
  ): Promise<PerformanceExperiment> {
    const context = await this.context(request, workspaceId);
    return this.performance.recordExperimentOutcome(
      context,
      parsePerformanceId(experimentId),
      parseRecordExperimentOutcomeRequest(body),
    );
  }

  @Get("experiments")
  public async listExperiments(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<PerformanceExperiment[]> {
    const context = await this.context(request, workspaceId);
    return this.performance.listExperiments(context, parsePerformanceChannelQuery(query).channelId);
  }

  @Post("strategy-changes")
  public async exportStrategyChange(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<PerformanceStrategyChange> {
    const context = await this.context(request, workspaceId);
    return this.performance.exportStrategyChange(context, parseExportStrategyChangeRequest(body));
  }

  @Get("strategy-changes")
  public async listStrategyChanges(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<PerformanceStrategyChange[]> {
    const context = await this.context(request, workspaceId);
    return this.performance.listStrategyChanges(
      context,
      parsePerformanceChannelQuery(query).channelId,
    );
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
