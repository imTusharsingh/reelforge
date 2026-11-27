import { sendLargeLegacyArtifact } from "./legacy-artifact.js";
import {
  claimMediaDelivery,
  defaultContentFilename,
  sendMediaContent,
  singleHeaderValue,
} from "../asset/content-delivery.js";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
} from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type { Response } from "express";
import { z } from "zod";
import { NotFoundException } from "@nestjs/common";
import { AuthGuard, type AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { RunsService } from "./runs.service.js";
import {
  attachRecoveredTextEvidence,
  RecoveredTextEvidenceSchema,
} from "./recovered-text-evidence.js";
import { RunsControl } from "./runs.control.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import { RunCreateSchema, type Context } from "./runs.types.js";

@Controller("runs")
@UseGuards(AuthGuard)
export class RunsController {
  public constructor(
    private readonly runs: RunsService,
    private readonly workspaces: WorkspaceService,
    private readonly control: RunsControl,
    private readonly artifacts: RunsArtifacts,
  ) {}
  @Post()
  @HttpCode(202)
  public async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    const parsed = RunCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const context = await this.context(request, parsed.data.workspaceId);
    const run = await this.runs.create(
      context,
      parsed.data.channelBriefId,
      parsed.data.idempotencyKey,
    );
    // The committed PLANNING row is the outbox; worker recovery dispatches it. No provider/queue wait here.
    return { id: run.id };
  }
  @Get(":id")
  public async get(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<unknown> {
    return this.runs.detail(await this.context(request, workspaceId), this.id(id));
  }
  @Sse(":id/events")
  public async events(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
    @Headers("last-event-id") last: string | undefined,
    @Query("after") after: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    const context = await this.context(request, workspaceId);
    await this.runs.store.get(context, this.id(id));
    const value = last ?? after ?? "0";
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new BadRequestException("Invalid event sequence");
    if (!this.runs.events) throw new NotFoundException("Event transport not configured");
    return this.runs.events.stream(context, id, Number(value));
  }
  @Post(":id/approve")
  public async approve(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<void> {
    await this.control.approve(await this.context(request, workspaceId), this.id(id));
  }
  @Post(":id/reedit")
  public async reedit(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<void> {
    await this.control.reedit(await this.context(request, workspaceId), this.id(id));
  }
  @Post(":id/resume")
  public async resume(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<void> {
    await this.control.resume(await this.context(request, workspaceId), this.id(id));
  }
  @Post(":id/cancel")
  public async cancel(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query("workspaceId") workspaceId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ pending: true } | void> {
    const pending = await this.control.cancel(
      await this.context(request, workspaceId),
      this.id(id),
    );
    if (pending) {
      response.status(202);
      return { pending: true };
    }
  }
  @Post(":id/steps/:stepId/abandon")
  public async abandon(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("stepId") stepId: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<void> {
    const resolution = z
      .object({ confirmedTerminalText: z.literal(true).optional() })
      .strict()
      .safeParse(body ?? {});
    if (!resolution.success) throw new BadRequestException("Invalid abandon confirmation");
    if (resolution.data.confirmedTerminalText)
      return this.control.abandonTerminalText(
        await this.context(request, workspaceId),
        this.id(id),
        this.id(stepId),
      );
    await this.control.abandon(
      await this.context(request, workspaceId),
      this.id(id),
      this.id(stepId),
    );
  }
  @Post(":id/steps/:stepId/text-evidence")
  @HttpCode(204)
  public async recordTextEvidence(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("stepId") stepId: string,
    @Query("workspaceId") workspaceId: string,
  ): Promise<void> {
    const parsed = RecoveredTextEvidenceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid text receipt evidence");
    await attachRecoveredTextEvidence(
      this.runs,
      await this.context(request, workspaceId),
      this.id(id),
      this.id(stepId),
      parsed.data,
    );
  }
  @Post(":id/reshoot/:ordinal")
  public async reshoot(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("ordinal") ordinal: string,
    @Query("workspaceId") workspaceId: string,
    @Query("sourceStepId") sourceStepId: string,
  ): Promise<{ stepId: string | null }> {
    const number = Number(ordinal);
    if (!Number.isSafeInteger(number) || number < 0)
      throw new BadRequestException("Invalid shot ordinal");
    return {
      stepId: await this.control.reshoot(
        await this.context(request, workspaceId),
        this.id(id),
        number,
        this.id(sourceStepId),
      ),
    };
  }
  @Get(":id/artifacts/:stepId/:checksum")
  public async content(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("stepId") stepId: string,
    @Param("checksum") checksum: string,
    @Query() query: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const context = await this.context(request, query.workspaceId);
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    const options = {
      signal: abort.signal,
      head: request.method === "HEAD",
      rangeHeader: singleHeaderValue(request.headers.range),
      ifRangeHeader: singleHeaderValue(request.headers["if-range"]),
    };
    const release = claimMediaDelivery(response);
    response.once("close", cancel);
    if (response.destroyed) cancel();
    try {
      const media = await this.artifacts.get(
        context,
        this.id(id),
        this.id(stepId),
        checksum,
        Number(query.expires),
        query.signature ?? "",
        options,
      );
      const content = {
        ...media,
        mediaType: media.contentType,
        filename: defaultContentFilename(media.contentType, "run-artifact"),
        checksumSha256: checksum,
        cacheControl: "private, no-store",
      };
      if (media.file) await sendLargeLegacyArtifact(response, content, options, media.file);
      else sendMediaContent(response, content, options);
    } catch (error) {
      release();
      throw error;
    } finally {
      response.off("close", cancel);
      if (response.destroyed) release();
    }
  }
  private id(value: unknown): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestException("Invalid UUID");
    return parsed.data;
  }
  private async context(request: AuthenticatedRequest, workspaceId: unknown): Promise<Context> {
    return this.workspaces.context(request.principal.userId, this.id(workspaceId));
  }
}
