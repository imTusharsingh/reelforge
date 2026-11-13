import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Delete,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { IdeaService } from "./idea.service.js";
import type { ApprovedIdeaSnapshot } from "./idea.types.js";
import {
  aiIdeaSchema,
  parseIdeaInput,
  transitionSchema,
  ideaMutationSchema,
  ideaArchiveSchema,
  ideaListQuerySchema,
} from "./idea.validation.js";

@Controller("workspaces/:workspaceId/ideas")
@UseGuards(AuthGuard)
export class IdeaController {
  public constructor(
    private readonly ideas: IdeaService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }

  @Get() public list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query() query: unknown,
  ): Promise<unknown> {
    const parsed = ideaListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.context(request, workspaceId).then((context) =>
      this.ideas.list(context, parsed.data.status, parsed.data.includeArchived === "true"),
    );
  }
  @Post() public create(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.ideas.create(context, parseIdeaInput(body), "USER"),
    );
  }
  @Post("propose") public propose(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = aiIdeaSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const proposalRequest = {
      prompt: parsed.data.prompt,
      ...(parsed.data.context === undefined ? {} : { contextText: parsed.data.context }),
      ...(parsed.data.channelId === undefined ? {} : { channelId: parsed.data.channelId }),
      ...(parsed.data.seriesId === undefined ? {} : { seriesId: parsed.data.seriesId }),
    };
    return this.context(request, workspaceId).then((context) =>
      this.ideas.propose(context, proposalRequest),
    );
  }

  @Patch(":ideaId")
  public edit(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = ideaMutationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { expectedUpdatedAt, ...input } = parsed.data;
    return this.context(request, workspaceId).then((context) =>
      this.ideas.edit(context, ideaId, input, new Date(expectedUpdatedAt)),
    );
  }

  @Post(":ideaId/archive")
  public archive(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = ideaArchiveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.context(request, workspaceId).then((context) =>
      this.ideas.archive(context, ideaId, new Date(parsed.data.expectedUpdatedAt)),
    );
  }

  @Delete(":ideaId")
  @Header("Deprecation", "true")
  public deprecatedArchive(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.archive(request, workspaceId, ideaId, body);
  }

  @Post(":ideaId/restore")
  public restore(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = ideaArchiveSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.context(request, workspaceId).then((context) =>
      this.ideas.restore(context, ideaId, new Date(parsed.data.expectedUpdatedAt)),
    );
  }

  @Patch(":ideaId/status") public transition(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body()
    body: unknown,
  ): Promise<unknown> {
    const parsed = transitionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.context(request, workspaceId).then((context) =>
      this.ideas.transition(
        context,
        ideaId,
        parsed.data.status,
        new Date(parsed.data.expectedUpdatedAt),
        parsed.data.expectedStatus,
        parsed.data.scheduledAt === undefined ? undefined : new Date(parsed.data.scheduledAt),
      ),
    );
  }

  @Get("approved/:ideaId") public approved(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
  ): Promise<ApprovedIdeaSnapshot> {
    return this.context(request, workspaceId).then((context) =>
      this.ideas.getApproved(context, ideaId),
    );
  }
}
