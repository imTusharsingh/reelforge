import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type {
  AssetRecord,
  AssetReference,
  AssetReferenceRequest,
  AssetUploadInput,
  AssetUsageRecord,
  StarterAssetImport,
} from "./asset.types.js";
import {
  assetExtension,
  buildAssetObjectKey,
  configuredMaxAssetBytes,
  isUuid,
  requireNonEmptyString,
  validateRights,
  validateUploadPayload,
} from "./asset.validation.js";
import { STORAGE_PORT } from "./storage/storage.port.js";
import type { StoragePort } from "./storage/storage.port.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);

type PersistedAsset = Awaited<ReturnType<Database["asset"]["create"]>>;

@Injectable()
export class AssetService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  public async list(context: WorkspaceContext): Promise<AssetRecord[]> {
    return this.db.asset.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    });
  }

  public async get(context: WorkspaceContext, assetId: string): Promise<AssetRecord> {
    if (!isUuid(assetId)) throw new BadRequestException("assetId must be a UUID");
    const asset = await this.db.asset.findFirst({
      where: { workspaceId: context.workspaceId, id: assetId },
    });
    if (!asset) throw new NotFoundException("Asset not found");
    return asset;
  }

  public async listVersions(
    context: WorkspaceContext,
    rootAssetId: string,
  ): Promise<AssetRecord[]> {
    if (!isUuid(rootAssetId)) throw new BadRequestException("rootAssetId must be a UUID");
    const anchor = await this.db.asset.findFirst({
      where: { workspaceId: context.workspaceId, id: rootAssetId },
    });
    if (!anchor) throw new NotFoundException("Asset not found");
    return this.db.asset.findMany({
      where: { workspaceId: context.workspaceId, rootAssetId: anchor.rootAssetId },
      orderBy: { version: "asc" },
    });
  }

  public async upload(context: WorkspaceContext, input: AssetUploadInput): Promise<AssetRecord> {
    this.assertCanMutate(context);
    const validated = validateUploadPayload(
      {
        body: input.body,
        declaredMediaType: input.declaredMediaType,
        filename: input.filename,
      },
      this.maxBytes(),
    );
    const rights = validateRights(input.rights);
    if (rights.ownership !== "USER_UPLOADED")
      throw new BadRequestException("User uploads must record ownership USER_UPLOADED");
    const assetId = randomUUID();
    const objectKey = buildAssetObjectKey(assetId, 1, validated.mediaType);
    const pending = await this.db.asset.create({
      data: {
        id: assetId,
        workspaceId: context.workspaceId,
        objectKey,
        mediaType: validated.mediaType,
        filename: validated.filename,
        byteSize: validated.byteSize,
        checksumSha256: validated.checksumSha256,
        version: 1,
        rootAssetId: assetId,
        ownership: rights.ownership,
        status: "PENDING",
        licenseType: rights.licenseType,
        ...(rights.licenseTerms === undefined ? {} : { licenseTerms: rights.licenseTerms }),
        rightsHolder: rights.rightsHolder,
        rightsAttestedAt: new Date(),
        createdByUserId: context.userId,
      },
    });
    return this.writeAndPublish(context, pending, input.body);
  }

  public async uploadVersion(
    context: WorkspaceContext,
    rootAssetId: string,
    input: AssetUploadInput,
  ): Promise<AssetRecord> {
    this.assertCanMutate(context);
    if (!isUuid(rootAssetId)) throw new BadRequestException("rootAssetId must be a UUID");
    const latest = await this.db.asset.findFirst({
      where: { workspaceId: context.workspaceId, rootAssetId },
      orderBy: { version: "desc" },
    });
    if (!latest) throw new NotFoundException("Asset not found");
    if (latest.status !== "PUBLISHED")
      throw new ConflictException(
        "The latest asset version is not published and cannot be superseded",
      );
    const validated = validateUploadPayload(
      {
        body: input.body,
        declaredMediaType: input.declaredMediaType,
        filename: input.filename,
      },
      this.maxBytes(),
    );
    const rights = validateRights(input.rights);
    if (rights.ownership !== "USER_UPLOADED")
      throw new BadRequestException("User uploads must record ownership USER_UPLOADED");
    const version = latest.version + 1;
    const assetId = randomUUID();
    const objectKey = buildAssetObjectKey(latest.rootAssetId, version, validated.mediaType);
    const pending = await this.db.asset.create({
      data: {
        id: assetId,
        workspaceId: context.workspaceId,
        objectKey,
        mediaType: validated.mediaType,
        filename: validated.filename,
        byteSize: validated.byteSize,
        checksumSha256: validated.checksumSha256,
        version,
        rootAssetId: latest.rootAssetId,
        supersedesAssetId: latest.id,
        ownership: rights.ownership,
        status: "PENDING",
        licenseType: rights.licenseType,
        ...(rights.licenseTerms === undefined ? {} : { licenseTerms: rights.licenseTerms }),
        rightsHolder: rights.rightsHolder,
        rightsAttestedAt: new Date(),
        createdByUserId: context.userId,
      },
    });
    return this.writeAndPublish(context, pending, input.body);
  }

  /**
   * Imports a project-owned starter asset into the workspace. The write is real
   * and idempotent: the same starter key maps to the same object key, and an
   * already-published copy is returned only when its checksum matches.
   */
  public async importStarterAsset(
    context: WorkspaceContext,
    input: StarterAssetImport,
  ): Promise<AssetRecord> {
    this.assertCanMutate(context);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.key))
      throw new BadRequestException("Starter asset key must be lowercase kebab-case");
    const validated = validateUploadPayload(
      {
        body: input.body,
        declaredMediaType: input.declaredMediaType,
        filename: input.filename,
      },
      this.maxBytes(),
    );
    const rightsHolder = requireNonEmptyString(input.rightsHolder, "rightsHolder");
    const licenseType = requireNonEmptyString(input.licenseType, "licenseType");
    const licenseTerms = requireNonEmptyString(input.licenseTerms, "licenseTerms");
    const objectKey = `starter-library/${input.key}.${assetExtension(validated.mediaType)}`;
    const existing = await this.db.asset.findFirst({
      where: { workspaceId: context.workspaceId, objectKey },
    });
    if (existing?.status === "PUBLISHED") {
      if (existing.checksumSha256 !== validated.checksumSha256)
        throw new ConflictException(
          "A published starter asset with this key has different bytes; starter assets are immutable",
        );
      return existing;
    }
    const stored = await this.storage.putObject({
      workspaceId: context.workspaceId,
      objectKey,
      body: input.body,
      contentType: validated.mediaType,
    });
    if (
      stored.checksumSha256 !== validated.checksumSha256 ||
      stored.byteSize !== validated.byteSize
    )
      throw new ServiceUnavailableException(
        "Starter asset storage returned a checksum or size that does not match the embedded bytes",
      );
    const rights = {
      filename: validated.filename,
      mediaType: validated.mediaType,
      byteSize: stored.byteSize,
      checksumSha256: stored.checksumSha256,
      ownership: "STARTER_LIBRARY" as const,
      status: "PUBLISHED" as const,
      licenseType,
      licenseTerms,
      rightsHolder,
      rightsAttestedAt: new Date(),
      createdByUserId: context.userId,
    };
    if (existing) {
      return this.db.asset.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: existing.id } },
        data: rights,
      });
    }
    const assetId = randomUUID();
    return this.db.asset.create({
      data: {
        id: assetId,
        workspaceId: context.workspaceId,
        objectKey,
        version: 1,
        rootAssetId: assetId,
        ...rights,
      },
    });
  }

  public async resolveReferences(
    context: WorkspaceContext,
    requests: readonly AssetReferenceRequest[],
  ): Promise<AssetReference[]> {
    const seen = new Set<string>();
    const references: AssetReference[] = [];
    for (const request of requests) {
      if (!isUuid(request.assetId))
        throw new BadRequestException("Every reference assetId must be a UUID");
      if (
        request.version !== undefined &&
        (!Number.isInteger(request.version) || request.version < 1)
      )
        throw new BadRequestException("Every reference asset version must be a positive integer");
      const key = `${request.assetId}@${request.version ?? "latest"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(await this.getReference(context, request));
    }
    return references;
  }

  public async getReference(
    context: WorkspaceContext,
    request: AssetReferenceRequest,
  ): Promise<AssetReference> {
    if (!isUuid(request.assetId)) throw new BadRequestException("assetId must be a UUID");
    if (
      request.version !== undefined &&
      (!Number.isInteger(request.version) || request.version < 1)
    )
      throw new BadRequestException("version must be a positive integer");
    const asset = await this.db.asset.findFirst({
      where: {
        workspaceId: context.workspaceId,
        ...(request.version === undefined
          ? { id: request.assetId }
          : {
              OR: [
                { id: request.assetId, version: request.version },
                { rootAssetId: request.assetId, version: request.version },
              ],
            }),
      },
      orderBy: { version: "desc" },
    });
    if (!asset) throw new NotFoundException("Asset version not found");
    if (asset.status !== "PUBLISHED")
      throw new ConflictException("Asset version is not published and cannot be referenced");
    if (
      asset.checksumSha256 === null ||
      asset.byteSize === null ||
      asset.licenseType === null ||
      asset.rightsHolder === null
    )
      throw new ConflictException(
        "Asset version is missing checksum, size, or rights metadata and cannot be referenced",
      );
    return {
      assetId: asset.id,
      version: asset.version,
      checksumSha256: asset.checksumSha256,
      objectKey: asset.objectKey,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      ownership: asset.ownership,
      licenseType: asset.licenseType,
      licenseTerms: asset.licenseTerms,
      rightsHolder: asset.rightsHolder,
    };
  }

  public async listUsage(context: WorkspaceContext, assetId: string): Promise<AssetUsageRecord[]> {
    await this.get(context, assetId);
    const rows = await this.db.assetUsageReference.findMany({
      where: { workspaceId: context.workspaceId, assetId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      assetId: row.assetId,
      assetVersion: row.assetVersion,
      usedByType: row.usedByType,
      usedById: row.usedById,
      context: (row.context ?? null) as AssetUsageRecord["context"],
      createdAt: row.createdAt,
    }));
  }

  private async writeAndPublish(
    context: WorkspaceContext,
    pending: PersistedAsset,
    body: Buffer,
  ): Promise<AssetRecord> {
    let stored;
    try {
      stored = await this.storage.putObject({
        workspaceId: context.workspaceId,
        objectKey: pending.objectKey,
        body,
        contentType: pending.mediaType,
      });
    } catch {
      await this.db.asset
        .update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: pending.id } },
          data: { status: "FAILED" },
        })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        "Asset storage write failed; the upload was not recorded as successful",
      );
    }
    if (stored.checksumSha256 !== pending.checksumSha256 || stored.byteSize !== pending.byteSize) {
      await this.db.asset
        .update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: pending.id } },
          data: { status: "FAILED" },
        })
        .catch(() => undefined);
      throw new ServiceUnavailableException(
        "Asset storage returned a checksum or size that does not match the uploaded bytes",
      );
    }
    return this.db.asset.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: pending.id } },
      data: {
        status: "PUBLISHED",
        checksumSha256: stored.checksumSha256,
        byteSize: stored.byteSize,
      },
    });
  }

  private maxBytes(): number {
    return configuredMaxAssetBytes();
  }

  private assertCanMutate(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Asset mutation requires owner or editor access");
  }
}
