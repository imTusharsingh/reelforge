import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import {
  NotificationsService,
  type NotificationDeliveryView,
  type NotificationPreferenceView,
  type NotificationView,
} from "./notifications.service.js";
import { ChannelReportsService, type ChannelReportView } from "./reports.service.js";

/** Every member reads and changes only their own notifications, preferences, and deliveries. */
@Controller("workspaces/:workspaceId/notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  public constructor(
    private readonly notifications: NotificationsService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get()
  public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    return this.notifications.listMine(await this.context(request, workspaceId), query);
  }

  @Post("read-all")
  public async readAll(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(await this.context(request, workspaceId));
  }

  @Get("preferences")
  public async preferences(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<NotificationPreferenceView[]> {
    return this.notifications.getPreferences(await this.context(request, workspaceId));
  }

  @Put("preferences")
  public async putPreferences(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<NotificationPreferenceView[]> {
    return this.notifications.putPreferences(await this.context(request, workspaceId), body);
  }

  @Get("deliveries")
  public async deliveries(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<NotificationDeliveryView[]> {
    return this.notifications.listMyDeliveries(await this.context(request, workspaceId));
  }

  @Post("deliveries/:deliveryId/retry")
  public async retryDelivery(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("deliveryId") deliveryId: string,
  ): Promise<NotificationDeliveryView> {
    return this.notifications.retryDelivery(await this.context(request, workspaceId), deliveryId);
  }

  @Post(":notificationId/read")
  public async read(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("notificationId") notificationId: string,
  ): Promise<NotificationView> {
    return this.notifications.markRead(await this.context(request, workspaceId), notificationId);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}

/** VIEWER can read reports; OWNER/EDITOR can generate. */
@Controller("workspaces/:workspaceId/channel-reports")
@UseGuards(AuthGuard)
export class ChannelReportsController {
  public constructor(
    private readonly reports: ChannelReportsService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get()
  public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<ChannelReportView[]> {
    return this.reports.list(await this.context(request, workspaceId), query);
  }

  @Post()
  public async generate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<ChannelReportView> {
    return this.reports.generate(await this.context(request, workspaceId), body);
  }

  @Get(":reportId")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("reportId") reportId: string,
  ): Promise<ChannelReportView> {
    return this.reports.get(await this.context(request, workspaceId), reportId);
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}
