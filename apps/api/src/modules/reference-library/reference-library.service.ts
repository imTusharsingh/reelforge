import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
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
import { defaultPins } from "./reference-selection.js";
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

  public async withInitializationLock<T>(
    context: WorkspaceContext,
    channelId: string,
    initialize: (assertLocked: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    // Keep the lock on a dedicated transaction while provider accounting commits independently.
    // A contender fails immediately instead of occupying a connection while a provider polls.
    const key = `reference-init:${context.workspaceId}:${channelId}`;
    return this.db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired
      `;
        if (!lock?.acquired)
          throw new ConflictException("Channel reference initialization in progress");
        return initialize(async () => {
          // A closed or expired transaction must never authorize a subsequent image dispatch.
          await tx.$queryRaw`SELECT 1`;
        });
      },
      // Allow four image jobs, each with up to 20 minutes of provider polling.
      { timeout: 90 * 60 * 1000 },
    );
  }

  public async initializeDefaults(
    context: WorkspaceContext,
    input: Omit<ChannelReferenceDefaults, "revision">,
    observed: ChannelReferenceDefaults | null,
  ): Promise<boolean> {
    const revision = (observed?.revision ?? 0) + 1;
    const defaults = ChannelReferenceDefaultsSchema.parse({
      ...input,
      id: observed?.id ?? input.id,
      revision,
    });
    if (defaults.workspaceId !== context.workspaceId)
      throw new ForbiddenException("Foreign defaults");
    if (
      observed &&
      (observed.workspaceId !== defaults.workspaceId ||
        observed.channelId !== defaults.channelId ||
        defaultPins(observed).length)
    )
      throw new Error("Expected empty channel defaults");
    await this.resolve(context, defaultPins(defaults));
    const scoped = foundationWorkspaceGuard(this.db, context);
    const result = observed
      ? await scoped.channelReferenceDefaults.updateMany({
          where: {
            channelId: defaults.channelId,
            revision: observed.revision,
            document: { equals: observed },
          },
          data: { revision, document: defaults },
        })
      : await scoped.channelReferenceDefaults.createMany({
          data: {
            id: defaults.id,
            workspaceId: defaults.workspaceId,
            channelId: defaults.channelId,
            revision,
            document: defaults,
          },
          skipDuplicates: true,
        });
    return result.count === 1;
  }

  public async setDefaults(
    context: WorkspaceContext,
    input: ChannelReferenceDefaults,
  ): Promise<void> {
    const defaults = ChannelReferenceDefaultsSchema.parse(input);
    if (defaults.workspaceId !== context.workspaceId)
      throw new ForbiddenException("Foreign defaults");
    const scoped = foundationWorkspaceGuard(this.db, context);
    await this.resolve(context, defaultPins(defaults));
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
