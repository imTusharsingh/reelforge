import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { type AnalyticsMetricDefinition, type MetricAggregate } from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { parseMetricAggregateQuery, parseMetricCollectionRequest } from "./analytics.validation.js";

@Controller("workspaces/:workspaceId")
@UseGuards(AuthGuard)
export class AnalyticsController {
  public constructor(
    private readonly analytics: AnalyticsService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("analytics/metrics")
  public async catalog(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<AnalyticsMetricDefinition[]> {
    await this.context(request, workspaceId);
    return this.analytics.listCatalog();
  }

  @Post("analytics/collection-jobs")
  public async scheduleCollection(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<{
    id: string;
    channelId: string;
    socialAccountId: string;
    startDate: string;
    endDate: string;
    status: "QUEUED";
    createdAt: string;
  }> {
    const context = await this.context(request, workspaceId);
    return this.analytics.scheduleCollection(context, parseMetricCollectionRequest(body));
  }

  @Get("channels/:channelId/metrics")
  public async aggregate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("channelId") channelId: string,
    @Query() query: unknown,
  ): Promise<MetricAggregate[]> {
    const context = await this.context(request, workspaceId);
    return this.analytics.aggregate(context, channelId, parseMetricAggregateQuery(query));
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
