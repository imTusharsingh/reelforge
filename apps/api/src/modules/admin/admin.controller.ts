import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  AdminService,
  type FailedJobsView,
  type ProviderStatusView,
  type QueueView,
  type RecentEventsView,
} from "./admin.service.js";
import { AuditService } from "./audit.service.js";
import { SkipHttpAudit, type AuditEventView } from "./audit.types.js";
import {
  EmergencyStopService,
  type EmergencyStopStatusView,
  type EmergencyStopView,
} from "./emergency-stop.service.js";

/**
 * M19 admin API (T02 audit read, T05 views, T06 emergency stop). Non-members get 403 from
 * `WorkspaceService.context`; all views are OWNER only except the emergency-stop status, which any
 * member can read. API only; there is no admin web UI.
 */
@Controller("workspaces/:workspaceId/admin")
@UseGuards(AuthGuard)
export class AdminController {
  public constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
    private readonly stops: EmergencyStopService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("audit-events")
  public async auditEvents(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<AuditEventView[]> {
    return this.audit.list(await this.context(request, workspaceId), query);
  }

  @Get("failed-jobs")
  public async failedJobs(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<FailedJobsView> {
    return this.admin.failedJobs(await this.context(request, workspaceId), query);
  }

  @Get("queue")
  public async queue(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<QueueView> {
    return this.admin.queue(await this.context(request, workspaceId));
  }

  @Get("providers")
  public async providers(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<ProviderStatusView> {
    return this.admin.providers(await this.context(request, workspaceId));
  }

  @Get("events")
  public async events(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<RecentEventsView> {
    return this.admin.recentEvents(await this.context(request, workspaceId), query);
  }

  @Get("emergency-stop")
  public async emergencyStop(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<EmergencyStopStatusView> {
    return this.stops.status(await this.context(request, workspaceId));
  }

  /** Writes its own ADMIN audit event with before/after and reason. */
  @Put("emergency-stop")
  @SkipHttpAudit()
  public async setEmergencyStop(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<EmergencyStopView> {
    return this.stops.set(await this.context(request, workspaceId), body);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
