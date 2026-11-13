import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ProviderError,
  type CapabilityMetadata,
  type ImageProviderPort,
  type TtsProviderPort,
  type VideoProviderPort,
} from "@reelforge/ai-providers";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { SceneMediaService } from "./scene-media.service.js";

@Controller("workspaces/:workspaceId/scene-media")
@UseGuards(AuthGuard)
export class SceneMediaController {
  public constructor(
    private readonly media: SceneMediaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  @Get("provider-health/:providerId/:capabilityId")
  public providerHealth(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
    @Param("capabilityId") capabilityId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.providerHealth(context, providerId, capabilityId),
    );
  }

  @Post("jobs")
  public create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.create(context, body));
  }

  @Get("jobs")
  public list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.list(context, query));
  }

  @Get("capabilities")
  public capabilities(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.capabilities(context));
  }

  @Get("jobs/:jobId")
  public get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.media.get(context, jobId));
  }

  @Get("jobs/:jobId/export")
  public exportPackage(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.exportPackage(context, jobId),
    );
  }

  @Post("jobs/:jobId/retry")
  public retry(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.retry(context, jobId, body),
    );
  }

  @Post("jobs/:jobId/scenes/:sceneId/regenerate")
  public regenerate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("sceneId") sceneId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.regenerate(context, jobId, sceneId, body),
    );
  }

  @Post("jobs/:jobId/scenes/:sceneId/replace")
  public replace(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("sceneId") sceneId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.replace(context, jobId, sceneId, body),
    );
  }

  @Post("jobs/:jobId/scenes/:sceneId/assign-asset")
  public assignAsset(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("jobId") jobId: string,
    @Param("sceneId") sceneId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.media.assignAsset(context, jobId, sceneId, body),
    );
  }

  private context(request: AuthenticatedRequest, workspaceId: string): Promise<WorkspaceContext> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
}

export function unconfiguredCapability(kind: CapabilityMetadata["kind"]): CapabilityMetadata {
  return {
    providerId: "unconfigured",
    capabilityId: kind,
    kind,
    input: ["text"],
    output: [kind],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: null },
  };
}

export class NotConfiguredImageProvider implements ImageProviderPort {
  public readonly capability = unconfiguredCapability("image");
  public generate(): never {
    throw new ProviderError("NOT_CONFIGURED", "Image provider is not configured", "image");
  }
}

export class NotConfiguredVideoProvider implements VideoProviderPort {
  public readonly capability = unconfiguredCapability("video");
  public generate(): never {
    throw new ProviderError("NOT_CONFIGURED", "Video provider is not configured", "video");
  }
}

export class NotConfiguredTtsProvider implements TtsProviderPort {
  public readonly capability = unconfiguredCapability("tts");
  public synthesize(): never {
    throw new ProviderError("NOT_CONFIGURED", "TTS provider is not configured", "tts");
  }
}
