import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ScriptService } from "./script.service.js";
import { scriptDocumentSchema } from "./script.validation.js";
import type { WorkspaceContext } from "../identity/identity.types.js";

const expectedRevisionSchema = z.number().int().positive();
const revisionWriteSchema = z
  .object({ expectedRevision: expectedRevisionSchema, document: scriptDocumentSchema })
  .strict();
const approvalWriteSchema = z.object({ expectedRevision: expectedRevisionSchema }).strict();
const pageSchema = z.coerce.number().int().min(1).max(10000).default(1);
function pageValue(value: unknown): number {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Invalid page number");
  return parsed.data;
}

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
  @Post()
  public generate(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.generate(context, body),
    );
  }

  @Get()
  public list(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Query("page") page?: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.list(context, pageValue(page)),
    );
  }
  @Get(":scriptId/revisions")
  public revisions(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
    @Query("page") page?: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.revisions(context, scriptId, pageValue(page)),
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
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => {
      if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
      const parsed = approvalWriteSchema.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues);
      return this.scripts.approve(context, scriptId, parsed.data.expectedRevision);
    });
  }
  @Post(":scriptId/revisions") public revise(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("scriptId") scriptId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) => {
      if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
      const parsed = revisionWriteSchema.safeParse(body);
      if (!parsed.success) throw new BadRequestException(parsed.error.issues);
      return this.scripts.revise(context, scriptId, parsed.data.document, parsed.data.expectedRevision);
    });
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
  @Get("provider-health/:providerId/:capabilityId") public providerHealth(
    @Req() request: AuthenticatedRequest,
    @Param("workspaceId") workspaceId: string,
    @Param("providerId") providerId: string,
    @Param("capabilityId") capabilityId: string,
  ): Promise<unknown> {
    return this.context(request, workspaceId).then((context) =>
      this.scripts.providerHealth(context, providerId, capabilityId),
    );
  }
}
