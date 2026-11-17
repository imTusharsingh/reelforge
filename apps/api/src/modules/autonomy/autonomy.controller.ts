import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { RunAutonomySelectionSchema, RunDecisionSchema } from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { AutonomyService } from "./autonomy.service.js";
import type { Context } from "../runs/runs.types.js";

@Controller("workspaces/:workspaceId/run-experience")
@UseGuards(AuthGuard)
export class AutonomyController {
  public constructor(
    private readonly autonomy: AutonomyService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private id(value: unknown): string {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw new BadRequestException("Invalid UUID");
    return result.data;
  }
  private context(request: AuthenticatedRequest, workspaceId: string): Promise<Context> {
    return this.workspaces.context(request.principal.userId, this.id(workspaceId));
  }
  @Get()
  public async list(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    const context = await this.context(req, workspaceId);
    return this.autonomy.store
      .scoped(context)
      .videoRun.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  }
  @Get("usage")
  public async usage(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    const db = this.autonomy.store.scoped(await this.context(req, workspaceId));
    const [shorts, providers] = await Promise.all([
      db.videoRunStep.groupBy({ by: ["runId"], _sum: { costMinor: true } }),
      db.videoRunStep.groupBy({ by: ["providerId"], _sum: { costMinor: true } }),
    ]);
    return {
      shorts: shorts.map((s) => ({ runId: s.runId, costMinor: s._sum.costMinor ?? 0 })),
      providers: providers.map((p) => ({
        providerId: p.providerId ?? "unattributed",
        costMinor: p._sum.costMinor ?? 0,
      })),
    };
  }
  @Get(":id/autonomy")
  public async status(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("id") id: string,
  ): Promise<unknown> {
    const context = await this.context(req, workspaceId);
    return this.autonomy.status(context, await this.autonomy.store.get(context, this.id(id)));
  }
  @Post(":id/autonomy")
  public async select(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = RunAutonomySelectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.autonomy.select(
      await this.context(req, workspaceId),
      this.id(id),
      parsed.data.requested,
    );
  }
  @Post(":id/decision")
  public async decide(
    @Req() req: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = RunDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.autonomy.decide(
      await this.context(req, workspaceId),
      this.id(id),
      parsed.data.decision,
    );
  }
}
