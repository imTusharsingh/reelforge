import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { GenreService } from "./genre.service.js";
@Controller("workspaces/:workspaceId")
@UseGuards(AuthGuard)
export class GenreController {
  public constructor(
    private readonly genres: GenreService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private context(
    request: AuthenticatedRequest,
    workspaceId: string,
  ): ReturnType<WorkspaceService["context"]> {
    return this.workspaces.context(request.principal.userId, workspaceId);
  }
  @Get("genre-templates") templates(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then(() => this.genres.templates());
  }
  @Get("genres") list(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.list(c));
  }
  @Post("genres") create(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Body() b: unknown,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.create(c, b));
  }
  @Get("genres/:genreId") get(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("genreId") id: string,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.get(c, id));
  }
  @Patch("genres/:genreId") update(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("genreId") id: string,
    @Body() b: unknown,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.update(c, id, b));
  }
  @Post("genres/from-template/:templateId") clone(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("templateId") id: string,
    @Body() b: unknown,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.clone(c, id, b));
  }
  @Get("channels/:channelId/series") series(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("channelId") ch: string,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.series(c, ch));
  }
  @Post("channels/:channelId/series") createSeries(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("channelId") ch: string,
    @Body() b: unknown,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.createSeries(c, ch, b));
  }
  @Patch("channels/:channelId/series/:seriesId") updateSeries(
    @Req() r: AuthenticatedRequest,
    @Param("workspaceId") w: string,
    @Param("channelId") ch: string,
    @Param("seriesId") id: string,
    @Body() b: unknown,
  ): Promise<unknown> {
    return this.context(r, w).then((c) => this.genres.updateSeries(c, ch, id, b));
  }
}
