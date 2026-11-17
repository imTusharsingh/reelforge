import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import type { PrismaClient } from "@reelforge/database";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { PublishingAutomation } from "./automation.service.js";
@Controller("workspaces/:workspaceId/publishing/automation")
@UseGuards(AuthGuard)
export class AutomationController {
  public constructor(
    @Inject("DATABASE") private readonly db: PrismaClient,
    private readonly workspaces: WorkspaceService,
    private readonly automation: PublishingAutomation,
  ) {}
  private uuid(value: string): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestException("Invalid UUID");
    return parsed.data;
  }
  @Get()
  public async list(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    const context = await this.workspaces.context(req.principal.userId, this.uuid(workspaceId));
    if (!pipelineV2Enabled()) return [];
    return this.db.v9PublishSlot.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { scheduledAt: "asc" },
      take: 200,
    });
  }
  @Get(":id")
  public async detail(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("id") id: string,
  ): Promise<unknown> {
    if (!pipelineV2Enabled()) throw new NotFoundException("pipeline.v2 is disabled");
    const context = await this.workspaces.context(req.principal.userId, this.uuid(workspaceId));
    const slot = await this.db.v9PublishSlot.findFirst({
      where: { workspaceId: context.workspaceId, id: this.uuid(id) },
    });
    if (!slot) throw new NotFoundException("Slot not found");
    return slot;
  }
  @Post(":runId/retry")
  public async retry(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.automation.retry(
      await this.workspaces.context(req.principal.userId, this.uuid(workspaceId)),
      this.uuid(runId),
    );
  }
}
