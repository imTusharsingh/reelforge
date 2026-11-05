import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { GenreInput, SeriesInput } from "./genre.types.js";
import type { JsonValue } from "../channel/channel.types.js";

const editable = new Set(["OWNER", "EDITOR"]);
const required = [
  "name",
  "audience",
  "tone",
  "topicsAllowed",
  "topicsBlocked",
  "language",
  "structure",
  "durationPreference",
  "safetyProfile",
] as const;
function object(body: unknown, label: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException(`${label} body must be an object`);
  return body as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new BadRequestException(`${field} must be a non-empty string`);
  return value.trim();
}
function jsonArray(value: unknown, field: string): JsonValue[] {
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array`);
  return value as JsonValue[];
}
function jsonObject(value: unknown, field: string): { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BadRequestException(`${field} must be a non-null object`);
  return value as { [key: string]: JsonValue };
}
function genreInput(body: unknown, partial = false): GenreInput | Partial<GenreInput> {
  const input = object(body, "Genre");
  const result: Record<string, unknown> = {};
  for (const field of required) {
    if (input[field] !== undefined || !partial)
      if (field === "name" || field === "audience" || field === "tone" || field === "language")
        result[field] = text(input[field], field);
      else if (field === "topicsAllowed" || field === "topicsBlocked")
        result[field] = jsonArray(input[field], field);
      else result[field] = jsonObject(input[field], field);
  }
  if (!partial && required.some((f) => result[f] === undefined))
    throw new BadRequestException("All genre fields are required");
  return result as GenreInput;
}
function seriesInput(body: unknown): SeriesInput {
  const input = object(body, "Series");
  return {
    name: text(input.name, "name"),
    genreId: text(input.genreId, "genreId"),
    format: text(input.format, "format"),
    frequency: text(input.frequency, "frequency"),
    characterGroupRefs: jsonArray(input.characterGroupRefs ?? [], "characterGroupRefs"),
    promptRefs: jsonArray(input.promptRefs ?? [], "promptRefs"),
  };
}

@Injectable()
export class GenreService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}
  private canMutate(context: WorkspaceContext): void {
    if (!editable.has(context.role))
      throw new ForbiddenException("Mutation requires owner or editor access");
  }
  public templates(): Promise<unknown> {
    return this.db.genreTemplate.findMany({ orderBy: { name: "asc" } });
  }
  public list(context: WorkspaceContext): Promise<unknown> {
    return this.db.genre.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }
  public get(context: WorkspaceContext, id: string): Promise<unknown> {
    return this.genre(context, id);
  }
  public async create(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.canMutate(context);
    return this.db.genre.create({
      data: { workspaceId: context.workspaceId, ...(genreInput(body) as GenreInput) } as never,
    });
  }
  public async update(context: WorkspaceContext, id: string, body: unknown): Promise<unknown> {
    this.canMutate(context);
    await this.get(context, id);
    return this.db.genre.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      data: genreInput(body, true) as never,
    });
  }
  public async clone(
    context: WorkspaceContext,
    templateId: string,
    body: unknown,
  ): Promise<unknown> {
    this.canMutate(context);
    const template = await this.db.genreTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException("Genre template not found");
    const name = text(object(body, "Genre").name, "name");
    return this.db.genre.create({
      data: {
        workspaceId: context.workspaceId,
        templateId,
        name,
        audience: template.audience,
        tone: template.tone,
        topicsAllowed: template.topicsAllowed,
        topicsBlocked: template.topicsBlocked,
        language: template.language,
        structure: template.structure,
        durationPreference: template.durationPreference,
        safetyProfile: template.safetyProfile,
      } as never,
    });
  }
  public async series(context: WorkspaceContext, channelId: string): Promise<unknown> {
    await this.channel(context, channelId);
    return this.db.contentSeries.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: { createdAt: "asc" },
    });
  }
  public async createSeries(
    context: WorkspaceContext,
    channelId: string,
    body: unknown,
  ): Promise<unknown> {
    this.canMutate(context);
    const channel = await this.channel(context, channelId);
    const input = seriesInput(body);
    const genre = await this.genre(context, input.genreId);
    this.assertCompatible(channel, genre);
    return this.db.contentSeries.create({
      data: { workspaceId: context.workspaceId, channelId, ...input } as never,
    });
  }
  public async updateSeries(
    context: WorkspaceContext,
    channelId: string,
    id: string,
    body: unknown,
  ): Promise<unknown> {
    this.canMutate(context);
    const channel = await this.channel(context, channelId);
    const input = seriesInput(body);
    const existing = await this.db.contentSeries.findFirst({
      where: { workspaceId: context.workspaceId, channelId, id },
    });
    if (!existing) throw new NotFoundException("Series not found");
    const genre = await this.genre(context, input.genreId);
    this.assertCompatible(channel, genre);
    return this.db.contentSeries.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      data: { ...input, channelId } as never,
    });
  }
  private async genre(context: WorkspaceContext, id: string): Promise<{ language: string }> {
    const row = await this.db.genre.findFirst({ where: { workspaceId: context.workspaceId, id } });
    if (!row) throw new NotFoundException("Genre not found");
    return row;
  }
  private async channel(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<{ language: string | null }> {
    const row = await this.db.channel.findFirst({
      where: { workspaceId: context.workspaceId, id: channelId },
    });
    if (!row) throw new NotFoundException("Channel not found in workspace");
    return row;
  }
  private assertCompatible(
    channel: { language: string | null },
    genre: { language: string },
  ): void {
    if (channel.language !== null && channel.language !== genre.language)
      throw new BadRequestException(
        `Channel language ${channel.language} is incompatible with genre language ${genre.language}`,
      );
  }
}
