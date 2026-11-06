import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ScriptService } from "./script.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";

@Controller("workspaces/:workspaceId/scripts")
@UseGuards(AuthGuard)
export class ScriptController {
  public constructor(
    private readonly scripts: ScriptService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
  @Post()
  public generate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.generate(context, body),
    );
  }
  @Get(":scriptId") public get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.get(context, scriptId),
    );
  }
  @Post(":scriptId/approve") public approve(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.approve(context, scriptId),
    );
  }
  @Post(":scriptId/revisions") public revise(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.revise(context, scriptId, body),
    );
  }
  @Get(":scriptId/export") public export(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.exportApproved(context, scriptId),
    );
  }
  @Get("provider-health/:providerId/:capabilityId") public providerHealth(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
    @Param("capabilityId") capabilityId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.providerHealth(context, providerId, capabilityId),
    );
  }
}
