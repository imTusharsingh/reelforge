import { Inject, Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { foundationWorkspaceGuard } from "@reelforge/database";
import {
  ChannelReferenceDefaultsSchema,
  ReferenceAssetSchema,
  ReferencePinSchema,
  type ChannelReferenceDefaults,
  type ReferenceAsset,
  type ReferencePin,
} from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { ReferenceLibrary } from "./planning.ports.js";

@Injectable()
export class ReferenceLibraryService implements ReferenceLibrary {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async resolve(
    context: WorkspaceContext,
    pins: readonly ReferencePin[],
  ): Promise<ReferenceAsset[]> {
    const scoped = foundationWorkspaceGuard(this.db, context);
    const resolved: ReferenceAsset[] = [];
    for (const input of pins) {
      const pin = ReferencePinSchema.parse(input);
      const row = await scoped.referenceAsset.findFirst({
        where: {
          referenceId: pin.referenceAssetId,
          version: pin.version,
        },
      });
      if (!row) throw new NotFoundException("Pinned reference version not found");
      const asset = ReferenceAssetSchema.parse(row.document);
      if (
        asset.workspaceId !== context.workspaceId ||
        asset.referenceId !== pin.referenceAssetId ||
        asset.version !== pin.version
      )
        throw new Error("Reference document does not match its immutable pin");
      resolved.push(asset);
    }
    return resolved;
  }

  public async defaults(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<ChannelReferenceDefaults | null> {
    const row = await foundationWorkspaceGuard(this.db, context).channelReferenceDefaults.findFirst(
      { where: { channelId } },
    );
    if (!row) return null;
    const defaults = ChannelReferenceDefaultsSchema.parse(row.document);
    if (defaults.workspaceId !== context.workspaceId || defaults.channelId !== channelId)
      throw new Error("Foreign channel defaults");
    return defaults;
  }

  public async save(context: WorkspaceContext, input: ReferenceAsset): Promise<void> {
    const asset = ReferenceAssetSchema.parse(input);
    if (asset.workspaceId !== context.workspaceId)
      throw new ForbiddenException("Foreign reference");
    await foundationWorkspaceGuard(this.db, context).referenceAsset.create({
      data: {
        id: asset.id,
        workspaceId: asset.workspaceId,
        referenceId: asset.referenceId,
        version: asset.version,
        kind: asset.kind,
        source: asset.source,
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        characterVersionId: asset.characterVersionId,
        checksumSha256: asset.checksumSha256,
        schemaVersion: asset.schemaVersion,
        document: asset,
      },
    });
  }

  public async setDefaults(
    context: WorkspaceContext,
    input: ChannelReferenceDefaults,
  ): Promise<void> {
    const defaults = ChannelReferenceDefaultsSchema.parse(input);
    if (defaults.workspaceId !== context.workspaceId)
      throw new ForbiddenException("Foreign defaults");
    const scoped = foundationWorkspaceGuard(this.db, context);
    await this.resolve(context, [
      ...defaults.character,
      ...defaults.scenery,
      ...defaults.style,
      ...defaults.prop,
    ]);
    await scoped.channelReferenceDefaults.upsert({
      where: {
        workspaceId_channelId: { workspaceId: context.workspaceId, channelId: defaults.channelId },
      },
      create: {
        id: defaults.id,
        workspaceId: defaults.workspaceId,
        channelId: defaults.channelId,
        revision: defaults.revision,
        document: defaults,
      },
      update: { revision: defaults.revision, document: defaults },
    });
  }
}
