import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { RenderManifest } from "./composition.manifest.js";

import { createHash } from "node:crypto";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { RenderArtifactView, RenderJobView } from "./composition.types.js";
import {
  validateManifestArtifactReferences,
  validateStoredManifest,
} from "./composition.manifest.js";
import { createRenderSchema, parse } from "./composition.validation.js";

@Injectable()
export class CompositionService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  public async getManifest(context: WorkspaceContext, id: string): Promise<RenderManifest> {
    const job = await this.present(context, id);
    const artifact = job.artifacts.find((item) => item.kind === "MANIFEST");
    if (job.status !== "SUCCEEDED" || !artifact)
      throw new ConflictException("A successful render and validated manifest are required");
    if (job.artifacts.length !== 2 + job.input.coverFrames.length)
      throw new ConflictException("Stored render artifact set is incomplete");
    const bound = validateManifestArtifactReferences(job.id, job.input, job.artifacts);
    try {
      const bytes = await Promise.all(
        bound.map(async (expected) => {
          const body = await this.storage.getObject({
            workspaceId: context.workspaceId,
            objectKey: expected.objectKey,
          });
          if (body.length !== expected.byteSize || checksum(body) !== expected.checksumSha256)
            throw new Error(`Stored ${expected.kind} size or digest mismatch`);
          return body;
        }),
      );
      return validateStoredManifest(bytes[bytes.length - 1]!, job.id, job.input, job.artifacts);
    } catch (error) {
      throw new ConflictException("Stored render artifact failed integrity validation", {
        cause: error,
      });
    }
  }
  private async present(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { artifacts: { orderBy: { createdAt: "asc" } } },
    });
    if (!job) throw new NotFoundException("Render job not found");
    const expired = job.artifacts.some(
      (artifact) => artifact.retainedUntil !== null && artifact.retainedUntil <= new Date(),
    );
    if (expired || job.expiredAt !== null)
      throw new ConflictException("Render artifacts have expired and are no longer available");
    if (job.schemaVersion !== "1.0")
      throw new ConflictException("Unsupported render schema version");
    const input = parse(createRenderSchema, {
      idempotencyKey: job.idempotencyKey,
      retentionDays: job.retentionDays,
      input: job.input,
    }).input;
    const artifacts: RenderArtifactView[] = job.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind as RenderArtifactView["kind"],
      assetId: artifact.assetId,
      assetVersion: artifact.assetVersion,
      objectKey: artifact.objectKey,
      mediaType: artifact.mediaType,
      byteSize: artifact.byteSize,
      checksumSha256: artifact.checksumSha256,
      metadata: artifact.metadata as RenderArtifactView["metadata"],
      retainedUntil: artifact.retainedUntil?.toISOString() ?? null,
    }));
    if (
      (job.status === "SUCCEEDED" &&
        (!artifacts.some((item) => item.kind === "VIDEO" && item.byteSize > 0) ||
          !artifacts.some((item) => item.kind === "MANIFEST" && item.byteSize > 0))) ||
      artifacts.some((item) => item.byteSize <= 0 || !/^[0-9a-f]{64}$/.test(item.checksumSha256))
    )
      throw new ConflictException("Successful render is missing validated media or checksum");
    return {
      id: job.id,
      schemaVersion: "1.0",
      workspaceId: job.workspaceId,
      sceneMediaJobId: job.sceneMediaJobId,
      status: job.status,
      attempt: job.attempt,
      idempotencyKey: job.idempotencyKey,
      inputFingerprint: job.inputFingerprint,
      input,
      cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      retentionDays: job.retentionDays,
      parentJobId: job.parentJobId,
      artifacts,
      nextRetryAt: job.nextAttemptAt.toISOString(),
      leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
      expiredAt: (job as { expiredAt: Date | null }).expiredAt?.toISOString() ?? null,
    };
  }
}
function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
