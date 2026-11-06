import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { PromptService } from "./prompt.service.js";

@Controller("workspaces/:workspaceId/prompts")
@UseGuards(AuthGuard)
export class PromptController {
  public constructor(
    private readonly prompts: PromptService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }

  @Get("templates") public async listTemplates(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.prompts.listTemplates(await this.context(request, workspaceId));
  }

  @Post("templates") public async createTemplate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.createTemplate(await this.context(request, workspaceId), body);
  }

  @Get("templates/:templateId") public async getTemplate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
  ): Promise<unknown> {
    return this.prompts.getTemplate(await this.context(request, workspaceId), templateId);
  }

  @Patch("templates/:templateId") public async updateTemplate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.updateTemplate(await this.context(request, workspaceId), templateId, body);
  }

  @Get("templates/:templateId/versions") public async listVersions(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
  ): Promise<unknown> {
    return this.prompts.listVersions(await this.context(request, workspaceId), templateId);
  }

  @Post("templates/:templateId/versions") public async createVersion(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.createVersion(await this.context(request, workspaceId), templateId, body);
  }

  @Get("templates/:templateId/versions/:versionId") public async getVersion(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
  ): Promise<unknown> {
    return this.prompts.getVersion(await this.context(request, workspaceId), templateId, versionId);
  }

  @Patch("templates/:templateId/versions/:versionId") public async updateVersion(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.updateVersion(
      await this.context(request, workspaceId),
      templateId,
      versionId,
      body,
    );
  }

  @Post("templates/:templateId/versions/:versionId/publish") public async publish(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
  ): Promise<unknown> {
    return this.prompts.publishVersion(
      await this.context(request, workspaceId),
      templateId,
      versionId,
    );
  }

  @Post("templates/:templateId/versions/:versionId/activate") public async activate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
  ): Promise<unknown> {
    return this.prompts.activateVersion(
      await this.context(request, workspaceId),
      templateId,
      versionId,
    );
  }

  @Post("templates/:templateId/rollback") public async rollback(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.rollback(await this.context(request, workspaceId), templateId, body);
  }

  @Post("preview") public async preview(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.preview(await this.context(request, workspaceId), body);
  }

  @Post("capture") public async capture(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.prompts.capture(await this.context(request, workspaceId), body);
  }

  @Get("bundle-snapshots") public async bundleSnapshots(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query("configSnapshotId") configSnapshotId?: string,
  ): Promise<unknown> {
    return this.prompts.listBundleSnapshots(
      await this.context(request, workspaceId),
      configSnapshotId,
    );
  }

  @Get("bundle-snapshots/:snapshotId") public async bundleSnapshot(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("snapshotId") snapshotId: string,
  ): Promise<unknown> {
    return this.prompts.getBundleSnapshot(await this.context(request, workspaceId), snapshotId);
  }
}
