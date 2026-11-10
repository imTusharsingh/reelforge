import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  UsageBudgetService,
  type AuditRecordView,
  type ChannelUsageView,
  type CostBreakdownView,
  type UsageSummaryView,
} from "./usage-budget.service.js";
import type { BudgetStatusView } from "./usage-budget.types.js";
import { parseUsageId } from "./usage-budget.validation.js";

/**
 * Read endpoints are open to every member (VIEWER and above); budget and adjustment writes are
 * OWNER only (enforced in the service). Reservations are an in-process API for paid callers and
 * have no HTTP surface.
 */
@Controller("workspaces/:workspaceId/usage")
@UseGuards(AuthGuard)
export class UsageBudgetController {
  public constructor(
    private readonly usage: UsageBudgetService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("summary")
  public async summary(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<UsageSummaryView> {
    return this.usage.usageSummary(await this.context(request, workspaceId), query);
  }

  @Get("channels")
  public async channels(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<ChannelUsageView> {
    return this.usage.channelUsage(await this.context(request, workspaceId), query);
  }

  @Get("videos/:scriptId")
  public async video(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
  ): Promise<CostBreakdownView> {
    const context = await this.context(request, workspaceId);
    return this.usage.videoBreakdown(context, parseUsageId(scriptId));
  }

  @Get("runs/:runId")
  public async run(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<CostBreakdownView> {
    const context = await this.context(request, workspaceId);
    return this.usage.runBreakdown(context, parseUsageId(runId));
  }

  @Get("budgets")
  public async budgets(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<BudgetStatusView[]> {
    return this.usage.listBudgets(await this.context(request, workspaceId));
  }

  @Put("budgets")
  public async upsertBudget(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<BudgetStatusView> {
    return this.usage.upsertBudget(await this.context(request, workspaceId), body);
  }

  @Post("adjustments")
  public async adjust(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<{ adjustmentId: string; correlationId: string; budgets: BudgetStatusView[] }> {
    return this.usage.createAdjustment(await this.context(request, workspaceId), body);
  }

  @Get("audit")
  public async audit(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<AuditRecordView[]> {
    return this.usage.listAudit(await this.context(request, workspaceId));
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
