import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { resolveConfig, type ConfigLayer } from "@reelforge/config-engine";
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
  type ResolvedConfigWithSources,
  type ResolveConfigRequest,
  type WorkspaceSnapshotRow,
} from "./config.types.js";
import { translateConfigError } from "./errors.js";

@Injectable()
export class ConfigService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

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
