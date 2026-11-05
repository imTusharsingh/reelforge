import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { CharacterService } from "./character.service.js";

@Controller("workspaces/:workspaceId")
@UseGuards(AuthGuard)
export class CharacterController {
  public constructor(
    private readonly characters: CharacterService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }

  @Get("character-templates") public async templates(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    await this.context(request, workspaceId);
    return this.characters.templates();
  }

  @Get("characters") public async list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.characters.list(await this.context(request, workspaceId));
  }

  @Post("characters") public async create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.create(await this.context(request, workspaceId), body);
  }

  @Get("characters/:characterId") public async get(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
  ): Promise<unknown> {
    return this.characters.get(await this.context(request, workspaceId), characterId);
  }

  @Patch("characters/:characterId") public async update(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.update(await this.context(request, workspaceId), characterId, body);
  }

  @Post("characters/:characterId/publish") public async publish(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
  ): Promise<unknown> {
    return this.characters.publish(await this.context(request, workspaceId), characterId);
  }

  @Post("characters/:characterId/archive") public async archive(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
  ): Promise<unknown> {
    return this.characters.archive(await this.context(request, workspaceId), characterId);
  }

  @Get("characters/:characterId/versions") public async versions(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
  ): Promise<unknown> {
    return this.characters.listVersions(await this.context(request, workspaceId), characterId);
  }

  @Get("characters/:characterId/versions/:version") public async version(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
    @Param("version") version: string,
  ): Promise<unknown> {
    const parsed = Number(version);
    if (!Number.isInteger(parsed))
      throw new BadRequestException("version must be a positive integer");
    return this.characters.getVersion(
      await this.context(request, workspaceId),
      characterId,
      parsed,
    );
  }

  @Get("characters/:characterId/reference-package") public async referencePackage(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("characterId") characterId: string,
    @Query("version") version?: string,
  ): Promise<unknown> {
    const parsed = version === undefined ? undefined : Number(version);
    if (parsed !== undefined && !Number.isInteger(parsed))
      throw new BadRequestException("version must be a positive integer");
    return this.characters.referencePackage(
      await this.context(request, workspaceId),
      characterId,
      parsed,
    );
  }

  @Get("character-groups") public async groups(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.characters.listGroups(await this.context(request, workspaceId));
  }

  @Post("character-groups") public async createGroup(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.createGroup(await this.context(request, workspaceId), body);
  }

  @Get("character-groups/:groupId") public async group(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
  ): Promise<unknown> {
    return this.characters.getGroup(await this.context(request, workspaceId), groupId);
  }

  @Patch("character-groups/:groupId") public async updateGroup(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.updateGroup(await this.context(request, workspaceId), groupId, body);
  }

  @Post("character-groups/:groupId/members") public async addMember(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.addMember(await this.context(request, workspaceId), groupId, body);
  }

  @Delete("character-groups/:groupId/members/:characterId") public async removeMember(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
    @Param("characterId") characterId: string,
  ): Promise<void> {
    return this.characters.removeMember(
      await this.context(request, workspaceId),
      groupId,
      characterId,
    );
  }

  @Post("character-groups/:groupId/assignments") public async assign(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.characters.assign(await this.context(request, workspaceId), groupId, body);
  }

  @Delete("character-groups/:groupId/assignments/:assignmentId")
  public async removeAssignment(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
    @Param("assignmentId") assignmentId: string,
  ): Promise<void> {
    return this.characters.removeAssignment(
      await this.context(request, workspaceId),
      groupId,
      assignmentId,
    );
  }

  @Get("character-groups/:groupId/reference-package") public async groupReferencePackage(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("groupId") groupId: string,
  ): Promise<unknown> {
    return this.characters.groupReferencePackage(await this.context(request, workspaceId), groupId);
  }
}
