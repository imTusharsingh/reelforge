import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ConfigService } from "./config.service.js";

@Controller("workspaces/:workspaceId/config")
@UseGuards(AuthGuard)
export class ConfigController {
  public constructor(
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }

  @Get() public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.config.getWorkspaceConfig(await this.context(request, workspaceId));
  }

  @Put() public async save(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.config.saveWorkspaceSnapshot(await this.context(request, workspaceId), body);
  }

  @Post("resolve") public async resolve(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.config.resolveUnknown(await this.context(request, workspaceId), body);
  }

  @Get("snapshots") public async snapshots(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.config.listWorkspaceSnapshots(await this.context(request, workspaceId));
  }

  @Post("snapshots/:snapshotId/activate") public async activate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("snapshotId") snapshotId: string,
  ): Promise<unknown> {
    return this.config.activateWorkspaceSnapshot(
      await this.context(request, workspaceId),
      snapshotId,
    );
  }

  @Get("generation-snapshots") public async generationSnapshots(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.config.listConfigSnapshots(await this.context(request, workspaceId));
  }

  @Get("generation-snapshots/:snapshotId") public async generationSnapshot(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("snapshotId") snapshotId: string,
  ): Promise<unknown> {
    return this.config.getConfigSnapshot(await this.context(request, workspaceId), snapshotId);
  }
}
