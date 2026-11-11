import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Head,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { AssetService } from "./asset.service.js";
import type { AssetReferenceRequest } from "./asset.types.js";
import {
  parseDownloadQuery,
  parsePositiveInteger,
  sendMediaContent,
  singleHeaderValue,
} from "./content-delivery.js";
import {
  configuredMaxAssetBytes,
  decodeBase64Upload,
  requireNonEmptyString,
  validateRights,
} from "./asset.validation.js";

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException("Asset body must be an object");
  return body as Record<string, unknown>;
}

@Controller("workspaces/:workspaceId/assets")
@UseGuards(AuthGuard)
export class AssetController {
  public constructor(
    private readonly assets: AssetService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }

  @Get() public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.assets.list(await this.context(request, workspaceId));
  }

  @Post() public async upload(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = bodyObject(body);
    const maxBytes = configuredMaxAssetBytes();
    return this.assets.upload(await this.context(request, workspaceId), {
      body: decodeBase64Upload(input.contentBase64, maxBytes),
      declaredMediaType: requireNonEmptyString(input.mediaType, "mediaType"),
      filename: requireNonEmptyString(input.filename, "filename"),
      rights: validateRights(input.rights),
    });
  }

  @Post("references/resolve") public async resolve(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const references = bodyObject(body).references;
    if (!Array.isArray(references)) throw new BadRequestException("references must be an array");
    return this.assets.resolveReferences(
      await this.context(request, workspaceId),
      references as AssetReferenceRequest[],
    );
  }

  @Get(":assetId") public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
  ): Promise<unknown> {
    return this.assets.get(await this.context(request, workspaceId), assetId);
  }

  @Get(":assetId/versions") public async versions(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
  ): Promise<unknown> {
    return this.assets.listVersions(await this.context(request, workspaceId), assetId);
  }

  @Post(":assetId/versions") public async uploadVersion(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = bodyObject(body);
    const maxBytes = configuredMaxAssetBytes();
    return this.assets.uploadVersion(await this.context(request, workspaceId), assetId, {
      body: decodeBase64Upload(input.contentBase64, maxBytes),
      declaredMediaType: requireNonEmptyString(input.mediaType, "mediaType"),
      filename: requireNonEmptyString(input.filename, "filename"),
      rights: validateRights(input.rights),
    });
  }

  @Get(":assetId/usage") public async usage(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
  ): Promise<unknown> {
    return this.assets.listUsage(await this.context(request, workspaceId), assetId);
  }

  @Get(":assetId/versions/:version/content") public async content(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Param("version") version: string,
    @Query("download") download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const content = await this.assets.getContent(
      await this.context(request, workspaceId),
      assetId,
      parsePositiveInteger(version, "version"),
    );
    sendMediaContent(response, content, {
      download: parseDownloadQuery(download),
      rangeHeader: singleHeaderValue(request.headers.range),
      ifRangeHeader: singleHeaderValue(request.headers["if-range"]),
    });
  }

  @Head(":assetId/versions/:version/content") public async contentHead(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("assetId") assetId: string,
    @Param("version") version: string,
    @Query("download") download: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const content = await this.assets.getContent(
      await this.context(request, workspaceId),
      assetId,
      parsePositiveInteger(version, "version"),
    );
    sendMediaContent(response, content, {
      download: parseDownloadQuery(download),
      head: true,
    });
  }
}
