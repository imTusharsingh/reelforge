import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { capabilityCatalog, providerModels, videoHealth } from "@reelforge/ai-providers";
import type { ProviderCapability } from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ProvidersRuntime } from "./providers.runtime.js";
import { ProviderKeys, parseVendor } from "./provider-keys.js";

@Controller("workspaces/:workspaceId/providers")
@UseGuards(AuthGuard)
export class ProvidersController {
  public constructor(
    private readonly keys: ProviderKeys,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: ProvidersRuntime,
  ) {}
  @Put(":providerId/key")
  public async write(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
    @Body() body: unknown,
  ): Promise<{ configured: true }> {
    return this.keys.write(
      await this.workspaces.context(request.principal.userId, workspaceId),
      parseVendor(providerId),
      body,
    );
  }
  @Delete(":providerId/key")
  public async remove(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
  ): Promise<void> {
    return this.keys.remove(
      await this.workspaces.context(request.principal.userId, workspaceId),
      parseVendor(providerId),
    );
  }
  @Get("keys")
  public async status(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<{ gemini: boolean; xai: boolean }> {
    const context = await this.workspaces.context(request.principal.userId, workspaceId);
    return this.keys.configured(context);
  }
  @Get("health")
  public async health(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<ProviderCapability[]> {
    const context = await this.workspaces.context(request.principal.userId, workspaceId);
    const state = await this.runtime.videoState(workspaceId);
    return capabilityCatalog(
      workspaceId,
      providerModels(process.env),
      await this.keys.configured(context),
    ).map((cap) =>
      cap.kind === "VIDEO"
        ? { ...cap, health: videoHealth(cap.health, state.get(cap.providerId), Date.now()) }
        : cap,
    );
  }
}
