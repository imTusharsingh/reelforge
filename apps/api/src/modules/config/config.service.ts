import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertValidLockPaths,
  jsonFingerprint,
  resolveConfig,
  type ConfigLayer,
  type JsonValue,
  type ResolvedConfig,
} from "@reelforge/config-engine";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import {
  channelLayerFromSnapshot,
  characterLayerFromVersions,
  genreLayerFromRow,
  seriesLayerFromRow,
  videoLayerFromRequest,
  workspaceLayerFromRequest,
  workspaceLayerFromSnapshot,
  type SeriesRow,
} from "./config.mappers.js";
import {
  ResolveConfigRequestSchema,
  WorkspaceConfigSaveRequestSchema,
  type ConfigSnapshotRow,
  type ResolvedConfigSources,
  type ResolvedConfigWithSources,
  type ResolveConfigRequest,
  type WorkspaceSnapshotRow,
} from "./config.types.js";
import { translateConfigError } from "./errors.js";
import { parseRequest, requireUuid } from "./validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const SNAPSHOT_WRITE_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class ConfigService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  private assertCanMutate(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Configuration mutation requires owner or editor access");
  }

  public async resolve(
    context: WorkspaceContext,
    request: ResolveConfigRequest,
  ): Promise<ResolvedConfig> {
    return (await this.resolveWithSources(context, request)).resolved;
  }

  public async resolveUnknown(context: WorkspaceContext, body: unknown): Promise<ResolvedConfig> {
    const request = parseRequest(ResolveConfigRequestSchema, body, "Configuration resolve request");
    return this.resolve(context, request);
  }

  public async resolveWithSources(
    context: WorkspaceContext,
    request: ResolveConfigRequest,
  ): Promise<ResolvedConfigWithSources> {
    const layers: ConfigLayer[] = [];
    let workspaceConfigSnapshotId: string | null = null;

    if (request.workspaceValues !== undefined) {
      layers.push(
        workspaceLayerFromRequest(request.workspaceValues, request.workspaceLockedFields ?? []),
      );
    } else {
      const snapshot = await this.workspaceSnapshotFor(context, request);
      if (snapshot !== null) {
        layers.push(workspaceLayerFromSnapshot(snapshot));
        workspaceConfigSnapshotId = snapshot.id;
      }
    }

    let channelId: string | null = request.channelId ?? null;
    let genreId: string | null = request.genreId ?? null;
    const seriesId: string | null = request.seriesId ?? null;
    let seriesRow: SeriesRow | null = null;

    if (seriesId !== null) {
      const row = await this.db.contentSeries.findFirst({
        where: { workspaceId: context.workspaceId, id: seriesId },
      });
      if (!row) throw new NotFoundException("Series not found");
      if (channelId !== null && row.channelId !== channelId)
        throw new BadRequestException("Series does not belong to the selected channel");
      if (genreId !== null && row.genreId !== genreId)
        throw new BadRequestException("Series genre does not match the selected genre");
      channelId = row.channelId;
      genreId = row.genreId;
      seriesRow = row;
    }

    if (channelId !== null) {
      const channel = await this.db.channel.findFirst({
        where: { workspaceId: context.workspaceId, id: channelId },
        include: { activeSnapshot: true },
      });
      if (!channel) throw new NotFoundException("Channel not found");
      if (!channel.activeSnapshot)
        throw new ConflictException("Channel has no active configuration snapshot");
      layers.push(
        channelLayerFromSnapshot({
          id: channel.activeSnapshot.id,
          workspaceId: channel.activeSnapshot.workspaceId,
          channelId: channel.id,
          version: channel.activeSnapshot.version,
          config: channel.activeSnapshot.config,
        }),
      );
    }

    if (genreId !== null) {
      const genre = await this.db.genre.findFirst({
        where: { workspaceId: context.workspaceId, id: genreId },
      });
      if (!genre) throw new NotFoundException("Genre not found");
      layers.push(genreLayerFromRow(genre));
    }

    if (seriesRow !== null) layers.push(seriesLayerFromRow(seriesRow));

    const characterVersionIds = request.characterVersionIds;
    if (characterVersionIds !== undefined && characterVersionIds.length > 0) {
      const ids = [...new Set(characterVersionIds)];
      const rows = await this.db.characterVersion.findMany({
        where: {
          workspaceId: context.workspaceId,
          id: { in: ids },
          status: "PUBLISHED",
        },
      });
      if (rows.length !== ids.length)
        throw new NotFoundException(
          "One or more published character versions were not found in this workspace",
        );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined);
      const characterLayer = characterLayerFromVersions(ordered);
      if (characterLayer !== null) layers.push(characterLayer);
    }

    const videoLayer = videoLayerFromRequest(request.video, request.promptTemplateRefs);
    if (videoLayer !== null) layers.push(videoLayer);

    try {
      const resolved = resolveConfig({ layers });
      return {
        resolved,
        sources: {
          workspaceConfigSnapshotId,
          channelId,
          genreId,
          seriesId,
        },
      };
    } catch (error) {
      translateConfigError(error);
    }
  }

  public async getWorkspaceConfig(context: WorkspaceContext): Promise<unknown> {
    const activeSnapshot = await this.workspaceSnapshotFor(context, {});
    const { resolved, sources } = await this.resolveWithSources(context, {});
    return {
      activeSnapshot,
      config: resolved.config,
      configSha256: resolved.configSha256,
      resolutionSha256: resolved.resolutionSha256,
      layers: resolved.layers,
      locks: resolved.locks,
      sources,
    };
  }

  public async saveWorkspaceSnapshot(
    context: WorkspaceContext,
    body: unknown,
  ): Promise<WorkspaceSnapshotRow> {
    this.assertCanMutate(context);
    const input = parseRequest(
      WorkspaceConfigSaveRequestSchema,
      body,
      "Workspace configuration snapshot",
    );
    try {
      assertValidLockPaths(input.lockedFields);
    } catch (error) {
      translateConfigError(error);
    }
    const values = input.values as unknown as JsonValue;
    const lockedFields = input.lockedFields as unknown as JsonValue;
    const fingerprintSha256 = jsonFingerprint({ values, lockedFields });

    let lastError: unknown;
    for (let attempt = 0; attempt < SNAPSHOT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return (await this.db.$transaction(async (tx) => {
          const latest = await tx.workspaceConfigSnapshot.findFirst({
            where: { workspaceId: context.workspaceId },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          const created = await tx.workspaceConfigSnapshot.create({
            data: {
              workspaceId: context.workspaceId,
              version: (latest?.version ?? 0) + 1,
              values: values as never,
              lockedFields: lockedFields as never,
              fingerprintSha256,
              createdByUserId: context.userId,
            },
          });
          await tx.workspace.update({
            where: { id: context.workspaceId },
            data: { activeConfigSnapshotId: created.id },
          });
          return created;
        })) as WorkspaceSnapshotRow;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new ConflictException(
      lastError instanceof Error
        ? `Could not allocate the next workspace configuration snapshot version: ${lastError.message}`
        : "Could not allocate the next workspace configuration snapshot version",
    );
  }

  public async listWorkspaceSnapshots(context: WorkspaceContext): Promise<WorkspaceSnapshotRow[]> {
    return (await this.db.workspaceConfigSnapshot.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { version: "desc" },
      take: 100,
    })) as WorkspaceSnapshotRow[];
  }

  public async activateWorkspaceSnapshot(
    context: WorkspaceContext,
    snapshotId: string,
  ): Promise<WorkspaceSnapshotRow> {
    this.assertCanMutate(context);
    requireUuid(snapshotId, "snapshotId");
    const snapshot = await this.workspaceConfigSnapshot(context, snapshotId);
    await this.db.workspace.update({
      where: { id: context.workspaceId },
      data: { activeConfigSnapshotId: snapshot.id },
    });
    return snapshot;
  }

  public async persistConfigSnapshot(
    context: WorkspaceContext,
    resolved: ResolvedConfig,
    sources: ResolvedConfigSources,
  ): Promise<ConfigSnapshotRow> {
    const config = resolved.config as unknown as JsonValue;
    const layers = resolved.layers as unknown as JsonValue;
    const lockedFields = resolved.lockedFields as unknown as JsonValue;

    let lastError: unknown;
    for (let attempt = 0; attempt < SNAPSHOT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return (await this.db.$transaction(async (tx) => {
          const latest = await tx.configSnapshot.findFirst({
            where: { workspaceId: context.workspaceId },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          return tx.configSnapshot.create({
            data: {
              workspaceId: context.workspaceId,
              version: (latest?.version ?? 0) + 1,
              workspaceConfigSnapshotId: sources.workspaceConfigSnapshotId,
              channelId: sources.channelId,
              genreId: sources.genreId,
              seriesId: sources.seriesId,
              config: config as never,
              fingerprintSha256: resolved.configSha256,
              resolutionSha256: resolved.resolutionSha256,
              layers: layers as never,
              lockedFields: lockedFields as never,
              createdByUserId: context.userId,
            },
          });
        })) as ConfigSnapshotRow;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new ConflictException(
      lastError instanceof Error
        ? `Could not allocate the next generation configuration snapshot version: ${lastError.message}`
        : "Could not allocate the next generation configuration snapshot version",
    );
  }

  public async getConfigSnapshot(
    context: WorkspaceContext,
    snapshotId: string,
  ): Promise<ConfigSnapshotRow> {
    requireUuid(snapshotId, "snapshotId");
    const snapshot = await this.db.configSnapshot.findFirst({
      where: { workspaceId: context.workspaceId, id: snapshotId },
    });
    if (!snapshot) throw new NotFoundException("Generation configuration snapshot not found");
    return snapshot as ConfigSnapshotRow;
  }

  public async listConfigSnapshots(context: WorkspaceContext): Promise<ConfigSnapshotRow[]> {
    return (await this.db.configSnapshot.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { version: "desc" },
      take: 100,
    })) as ConfigSnapshotRow[];
  }

  private async workspaceSnapshotFor(
    context: WorkspaceContext,
    request: ResolveConfigRequest,
  ): Promise<WorkspaceSnapshotRow | null> {
    if (request.workspaceValues !== undefined) return null;
    if (request.workspaceConfigSnapshotId !== undefined)
      return this.workspaceConfigSnapshot(context, request.workspaceConfigSnapshotId);

    const workspace = await this.db.workspace.findFirst({
      where: { id: context.workspaceId },
      select: { activeConfigSnapshotId: true },
    });
    if (!workspace) throw new ForbiddenException("Workspace access denied");
    if (workspace.activeConfigSnapshotId === null) return null;
    return this.workspaceConfigSnapshot(context, workspace.activeConfigSnapshotId);
  }

  private async workspaceConfigSnapshot(
    context: WorkspaceContext,
    snapshotId: string,
  ): Promise<WorkspaceSnapshotRow> {
    const snapshot = await this.db.workspaceConfigSnapshot.findFirst({
      where: { workspaceId: context.workspaceId, id: snapshotId },
    });
    if (!snapshot) throw new NotFoundException("Workspace configuration snapshot not found");
    return snapshot as WorkspaceSnapshotRow;
  }
}
