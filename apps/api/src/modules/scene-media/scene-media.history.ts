import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@reelforge/database";
import type { SceneMediaJobList } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import {
  SCENE_MEDIA_SCHEMA_VERSION,
  type RequestedOutputs,
  type SceneMediaPackage,
} from "./scene-media.types.js";
import { parseSceneMediaJobListQuery } from "./scene-media.validation.js";
export function legacyOutputs(value: Prisma.JsonValue): RequestedOutputs {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value.image !== true)
    throw new ConflictException("Scene media job outputs are invalid");
  return {
    image: true,
    video: value.video === true,
    narration: value.narration === true,
    dialogue: value.dialogue === true,
  };
}
export class SceneMediaHistory {
  public constructor(private readonly db: Database) {}
  public async list(context: WorkspaceContext, query: unknown): Promise<SceneMediaJobList> {
    const parsed = parseSceneMediaJobListQuery(query);
    const rows = await this.db.sceneMediaJob.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(parsed.scriptId ? { scriptId: parsed.scriptId } : {}),
        ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize + 1,
    });
    return {
      items: rows.slice(0, parsed.pageSize).map((row) => ({
        jobId: row.id,
        workspaceId: row.workspaceId,
        scriptId: row.scriptId,
        scriptRevision: row.scriptRevision,
        channelId: row.channelId,
        status: row.status,
        version: row.version,
        idempotencyKey: row.idempotencyKey,
        configSnapshotId: row.configSnapshotId,
        promptSnapshotId: row.promptSnapshotId,
        requestedOutputs: legacyOutputs(row.requestedOutputs),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      page: parsed.page,
      pageSize: parsed.pageSize,
      nextPage: rows.length > parsed.pageSize ? parsed.page + 1 : null,
    };
  }
  public async get(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
    const job = await this.db.sceneMediaJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
      include: {
        scenes: {
          where: { activeSlot: 1 },
          orderBy: { ordinal: "asc" },
          include: { outputs: { orderBy: { kind: "asc" } } },
        },
      },
    });
    if (!job) throw new NotFoundException("Scene media job not found");
    if (job.schemaVersion !== SCENE_MEDIA_SCHEMA_VERSION)
      throw new ConflictException("Scene media job schema version is not supported");
    return {
      schemaVersion: SCENE_MEDIA_SCHEMA_VERSION,
      jobId: job.id,
      workspaceId: job.workspaceId,
      scriptId: job.scriptId,
      scriptRevision: job.scriptRevision,
      channelId: job.channelId,
      status: job.status,
      version: job.version,
      idempotencyKey: job.idempotencyKey,
      configSnapshotId: job.configSnapshotId,
      promptSnapshotId: job.promptSnapshotId,
      requestedOutputs: legacyOutputs(job.requestedOutputs),
      scenes: job.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        ordinal: scene.ordinal,
        sceneVersion: scene.sceneVersion,
        status: scene.status,
        idempotencyKey: scene.idempotencyKey,
        sourceRefs: scene.sourceRefs,
        outputs: scene.outputs.map((output) => ({
          kind: output.kind,
          status: output.status,
          assetId: output.assetId,
          assetVersion: output.assetVersion,
          mediaType: output.mediaType,
          byteSize: output.byteSize,
          checksumSha256: output.checksumSha256,
          providerJobId: output.providerJobId,
          providerAssetId: output.providerAssetId,
          correlationId: output.correlationId,
          reusedFromOutputId: output.reusedFromOutputId,
          errorCode: output.errorCode,
          errorMessage: output.errorMessage,
        })),
      })),
    };
  }
}
