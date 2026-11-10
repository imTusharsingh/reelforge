import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ChannelRepository } from "./channel.repository.js";
import type { ChannelInput, ChannelPatch, ChannelStatus, JsonValue } from "./channel.types.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const jsonKeys = [
  "goals",
  "schedule",
  "automationDefaults",
  "approvalPolicy",
  "publishingDestinations",
] as const;

function clean(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new BadRequestException(`${field} must be a non-empty string`);
  return value.trim();
}

function validateInput(body: unknown, partial: boolean): ChannelInput | ChannelPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException("Channel body must be an object");
  const input = body as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of [
    "name",
    "handle",
    "description",
    "niche",
    "language",
    "audience",
    "timezone",
  ]) {
    const value = clean(input[field], field);
    if (value !== undefined) result[field] = value;
  }
  if (!partial && !result.name) throw new BadRequestException("name must be provided");
  for (const key of jsonKeys) {
    if (input[key] !== undefined && input[key] !== null) result[key] = input[key] as JsonValue;
  }
  return result as ChannelInput | ChannelPatch;
}

function updateData(input: ChannelPatch): Record<string, string | JsonValue> {
  const data: Record<string, string | JsonValue> = {};
  for (const key of [
    "name",
    "handle",
    "description",
    "niche",
    "language",
    "audience",
    "timezone",
    "goals",
    "schedule",
    "automationDefaults",
    "approvalPolicy",
    "publishingDestinations",
  ] as const) {
    const value = input[key];
    if (value !== undefined) data[key] = value;
  }
  return data;
}

export function configurationFromRow(row: Record<string, unknown>): ChannelInput {
  return validateInput(
    {
      name: row.name,
      handle: row.handle,
      description: row.description,
      niche: row.niche,
      language: row.language,
      audience: row.audience,
      timezone: row.timezone,
      goals: row.goals,
      schedule: row.schedule,
      automationDefaults: row.automationDefaults,
      approvalPolicy: row.approvalPolicy,
      publishingDestinations: row.publishingDestinations,
    },
    false,
  ) as ChannelInput;
}

@Injectable()
export class ChannelService {
  private readonly repository: ChannelRepository;
  public constructor(@Inject("DATABASE") private readonly db: Database) {
    this.repository = new ChannelRepository(db);
  }

  public list(context: WorkspaceContext): Promise<unknown> {
    return this.repository.findMany(context);
  }
  public async get(context: WorkspaceContext, id: string): Promise<{ status: ChannelStatus }> {
    const channel = await this.repository.find(context, id);
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  public async create(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    const input = validateInput(body, false) as ChannelInput;
    return this.db.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: { workspaceId: context.workspaceId, ...input },
      });
      const snapshot = await tx.channelConfigSnapshot.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: channel.id,
          version: 1,
          config: input,
        },
      });
      return tx.channel.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: channel.id } },
        data: { activeSnapshotId: snapshot.id },
        include: { activeSnapshot: true },
      });
    });
  }

  public async update(context: WorkspaceContext, id: string, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    await this.get(context, id);
    const input = validateInput(body, true) as ChannelPatch;
    const data = updateData(input);
    return this.db.$transaction(async (tx) => {
      const channel = await tx.channel.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        data,
      });
      const latest = await tx.channelConfigSnapshot.findFirst({
        where: { workspaceId: context.workspaceId, channelId: id },
        orderBy: { version: "desc" },
      });
      const snapshot = await tx.channelConfigSnapshot.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: id,
          version: (latest?.version ?? 0) + 1,
          config: configurationFromRow(channel as unknown as Record<string, unknown>),
        },
      });
      return tx.channel.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        data: { activeSnapshotId: snapshot.id },
        include: { activeSnapshot: true },
      });
    });
  }

  public async setStatus(
    context: WorkspaceContext,
    id: string,
    status: "ACTIVE" | "PAUSED" | "ARCHIVED",
  ): Promise<unknown> {
    this.assertCanMutate(context);
    await this.get(context, id);
    return this.db.channel.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      data: { status },
    });
  }

  public async selectSnapshot(
    context: WorkspaceContext,
    id: string,
    snapshotId: string,
  ): Promise<unknown> {
    this.assertCanMutate(context);
    const snapshot = await this.db.channelConfigSnapshot.findFirst({
      where: { workspaceId: context.workspaceId, channelId: id, id: snapshotId },
    });
    if (!snapshot) throw new NotFoundException("Channel configuration snapshot not found");
    const config = validateInput(snapshot.config, false) as ChannelInput;
    return this.db.$transaction(async (tx) =>
      tx.channel.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        data: { ...updateData(config), activeSnapshotId: snapshot.id },
        include: { activeSnapshot: true },
      }),
    );
  }

  public async listSnapshots(context: WorkspaceContext, id: string): Promise<unknown> {
    await this.get(context, id);
    return this.db.channelConfigSnapshot.findMany({
      where: { workspaceId: context.workspaceId, channelId: id },
      select: { id: true, channelId: true, version: true, createdAt: true, config: true },
      orderBy: { version: "desc" },
    });
  }

  /**
   * @internal Cross-workspace read for the M16 scheduler tick only. It bypasses workspace
   * scoping, so never expose it through a controller or call it with a user context.
   */
  public async listSchedulerCandidates(): Promise<
    ReadonlyArray<{
      id: string;
      workspaceId: string;
      status: "ACTIVE" | "PAUSED" | "ARCHIVED";
      timezone: string;
      schedule: unknown;
      approvalPolicy: unknown;
    }>
  > {
    return this.db.channel.findMany({
      where: { schedule: { not: Prisma.DbNull } },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        timezone: true,
        schedule: true,
        approvalPolicy: true,
      },
      orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }],
    });
  }

  /**
   * @internal Read for M17 reports and the report schedule tick. Cross-workspace when no
   * workspaceId is given, so never expose it through a controller or call it with user input
   * without a workspaceId.
   */
  public async listReportChannels(
    filter: { readonly workspaceId?: string; readonly channelId?: string } = {},
  ): Promise<
    ReadonlyArray<{
      id: string;
      workspaceId: string;
      name: string;
      status: "ACTIVE" | "PAUSED" | "ARCHIVED";
      timezone: string;
    }>
  > {
    return this.db.channel.findMany({
      where: {
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
        ...(filter.channelId === undefined ? {} : { id: filter.channelId }),
      },
      select: { id: true, workspaceId: true, name: true, status: true, timezone: true },
      orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }],
    });
  }

  public async assertChannelAllowsAutonomousWork(
    context: WorkspaceContext,
    id: string,
  ): Promise<void> {
    const channel = await this.get(context, id);
    if (channel.status !== "ACTIVE")
      throw new ForbiddenException(
        `Channel is ${channel.status.toLowerCase()} and cannot start autonomous work`,
      );
  }

  private assertCanMutate(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Channel mutation requires owner or editor access");
  }
}
