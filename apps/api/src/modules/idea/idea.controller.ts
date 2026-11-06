import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { IdeaService } from "./idea.service.js";
import { aiIdeaSchema, parseIdeaInput } from "./idea.validation.js";

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
    @Query("status") status?: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => this.ideas.list(context, status));
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
    if (!parsed.success) throw new Error("Invalid AI idea request");
    return this.context(request, workspaceId).then((context) =>
      this.ideas.propose(context, parsed.data.prompt, parsed.data.context),
    );
  }
  @Patch(":ideaId/status") public transition(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("ideaId") ideaId: string,
    @Body()
    body: { status: "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED"; scheduledAt?: string },
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.ideas.transition(
        context,
        ideaId,
        body.status,
        body.scheduledAt === undefined ? undefined : new Date(body.scheduledAt),
      ),
    );
  }
}
