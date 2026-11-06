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
  @Post() public generate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    if (!body || typeof body !== "object")
      throw new BadRequestException("Request body is required");
    const value = body as Record<string, unknown>;
    if (
      typeof value.approvedIdeaSnapshotId !== "string" ||
      typeof value.approvedIdeaChecksum !== "string" ||
      typeof value.prompt !== "string"
    )
      throw new BadRequestException(
        "approvedIdeaSnapshotId, approvedIdeaChecksum, and prompt are required",
      );
    return this.context(request, workspaceId).then((context) =>
      this.scripts.generate(context, {
        approvedIdeaSnapshotId: value.approvedIdeaSnapshotId as string,
        approvedIdeaChecksum: value.approvedIdeaChecksum as string,
        prompt: value.prompt as string,
      }),
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
}
