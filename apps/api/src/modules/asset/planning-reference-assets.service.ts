import { deliveryChunkHashes } from "./content-delivery.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { STORAGE_PORT, type StoragePort } from "./storage/storage.port.js";
import { validateUploadPayload, configuredMaxAssetBytes } from "./asset.validation.js";

@Injectable()
export class PlanningReferenceAssetsService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  public async store(
    context: WorkspaceContext,
    image: { body: Buffer; mediaType: string },
  ): Promise<{ assetId: string; version: number; checksumSha256: string }> {
    if (context.role === "VIEWER") throw new Error("Editor permission required");
    const validated = validateUploadPayload(
      { body: image.body, declaredMediaType: image.mediaType, filename: "reference.png" },
      configuredMaxAssetBytes(),
    );
    const objectKey = `planning/${validated.checksumSha256}`;
    const stored = await this.storage.putObject({
      workspaceId: context.workspaceId,
      objectKey,
      body: image.body,
      contentType: validated.mediaType,
    });
    if (
      stored.checksumSha256 !== validated.checksumSha256 ||
      stored.byteSize !== validated.byteSize
    )
      throw new Error("Reference storage verification failed");
    const existing = await this.db.asset.findFirst({
      where: { workspaceId: context.workspaceId, objectKey, status: "PUBLISHED" },
    });
    if (existing)
      return {
        assetId: existing.id,
        version: existing.version,
        checksumSha256: validated.checksumSha256,
      };
    const id = randomUUID();
    await this.db.asset.create({
      data: {
        id,
        workspaceId: context.workspaceId,
        rootAssetId: id,
        version: 1,
        objectKey,
        mediaType: validated.mediaType,
        filename: validated.filename,
        byteSize: validated.byteSize,
        checksumSha256: validated.checksumSha256,
        deliveryChunkHashes: deliveryChunkHashes(image.body),
        ownership: "SYSTEM_GENERATED",
        status: "PUBLISHED",
        licenseType: "SYSTEM_GENERATED",
        rightsHolder: context.workspaceId,
        rightsAttestedAt: new Date(),
        createdByUserId: context.userId,
      },
    });
    return { assetId: id, version: 1, checksumSha256: validated.checksumSha256 };
  }
}
