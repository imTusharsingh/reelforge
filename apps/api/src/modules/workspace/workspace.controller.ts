import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "./workspace.service.js";

@Controller("workspaces")
@UseGuards(AuthGuard)
export class WorkspaceController {
  public constructor(private readonly workspaces: WorkspaceService) {}

  @Post()
  public create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<{ id: string; name: string }> {
    if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).name !== "string") throw new Error("Workspace name is required");
    return this.workspaces.create(request.principal.userId, (body as { name: string }).name);
  }

  @Get()
  public list(@Req() request: AuthenticatedRequest): ReturnType<WorkspaceService["list"]> { return this.workspaces.list(request.principal.userId); }

  @Delete(":workspaceId")
  public async archive(@Req() request: AuthenticatedRequest, @Param("workspaceId") workspaceId: string): Promise<{ ok: true }> {
    const context = await this.workspaces.context(request.principal.userId, workspaceId);
    await this.workspaces.archive(context);
    return { ok: true };
  }
}
