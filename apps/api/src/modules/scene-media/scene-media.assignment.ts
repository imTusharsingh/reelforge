import { createHash, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { parseAssignAssetInput, KIND_MEDIA } from "./scene-media.validation.js";
/** @deprecated C3 asset assignment only; retained until T2. No provider dispatch exists here. */
export class SceneMediaAssignment {
  public constructor(private readonly db: Database) {}
  public async assign(
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    body: unknown,
  ): Promise<void> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const input = parseAssignAssetInput(body);
    const hash = createHash("sha256")
      .update(JSON.stringify({ sceneId, ...input }))
      .digest("hex");
    await this.db.$transaction(async (tx) => {
      if (await this.claim(tx, context, jobId, input, hash)) return;
      const scene = await tx.sceneGeneration.findFirst({
        where: { workspaceId: context.workspaceId, jobId, sceneId, activeSlot: 1 },
        include: { outputs: true },
      });
      if (!scene) throw new NotFoundException("SCENE_NOT_FOUND");
      const before = await tx.sceneGeneration.findMany({
        where: { workspaceId: context.workspaceId, jobId, activeSlot: 1 },
      });
      if (
        before.some((item) => item.status === "PROVIDER_PROCESSING") ||
        !scene.outputs.some((out) => out.kind === input.kind)
      )
        throw new ConflictException("KIND_NOT_APPLICABLE or unresolved provider operation");
      const asset = await tx.asset.findFirst({
        where: {
          workspaceId: context.workspaceId,
          version: input.assetVersion,
          OR: [{ id: input.assetId }, { rootAssetId: input.assetId }],
        },
      });
      if (!asset) throw new NotFoundException("ASSET_NOT_FOUND");
      if (asset.status !== "PUBLISHED" || !asset.byteSize || !asset.checksumSha256)
        throw new ConflictException("ASSET_NOT_READY");
      if (!(KIND_MEDIA[input.kind] as readonly string[]).includes(asset.mediaType))
        throw new ConflictException("ASSET_KIND_INCOMPATIBLE");
      const next = await this.replace(tx, context, jobId, sceneId, scene, input, asset);
      await this.rollup(tx, context, jobId);
      await this.record(tx, context, jobId, sceneId, input, hash, before, next);
    });
  }
  private async claim(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    jobId: string,
    input: ReturnType<typeof parseAssignAssetInput>,
    hash: string,
  ): Promise<boolean> {
    const previous = await tx.sceneMediaMutation.findUnique({
      where: {
        workspaceId_jobId_idempotencyKey: {
          workspaceId: context.workspaceId,
          jobId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (previous) {
      if (previous.payloadHash !== hash || previous.status !== "SUCCEEDED")
        throw new ConflictException("Assignment requires reconciliation");
      return true;
    }
    const job = await tx.sceneMediaJob.findFirst({
      where: { id: jobId, workspaceId: context.workspaceId },
    });
    if (!job) throw new NotFoundException("Scene media job not found");
    const claimed = await tx.sceneMediaJob.updateMany({
      where: {
        id: jobId,
        workspaceId: context.workspaceId,
        version: input.expectedJobVersion,
        OR: [{ leaseId: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      data: { version: { increment: 1 } },
    });
    if (claimed.count !== 1)
      throw new ConflictException("Job version is stale or operation running");
    return false;
  }
  private async replace(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    scene: Prisma.SceneGenerationGetPayload<{ include: { outputs: true } }>,
    input: ReturnType<typeof parseAssignAssetInput>,
    asset: Prisma.AssetGetPayload<object>,
  ): Promise<Prisma.SceneGenerationGetPayload<object>> {
    await tx.sceneGeneration.updateMany({
      where: { id: scene.id, workspaceId: context.workspaceId },
      data: { activeSlot: null },
    });
    const next = await tx.sceneGeneration.create({
      data: {
        workspaceId: context.workspaceId,
        jobId,
        sceneId,
        ordinal: scene.ordinal,
        sceneVersion: scene.sceneVersion + 1,
        status: "SUCCEEDED",
        idempotencyKey: `${jobId}:${sceneId}:v${scene.sceneVersion + 1}`,
        sourceRefs: scene.sourceRefs ?? Prisma.JsonNull,
        resolvedPrompt: scene.resolvedPrompt,
        activeSlot: 1,
      },
    });
    const statuses = [];
    for (const output of scene.outputs)
      statuses.push(await this.copyOutput(tx, context, next.id, output, input.kind, asset));
    const success = statuses.every((status) =>
      ["SUCCEEDED", "ASSIGNED", "REUSED"].includes(status),
    );
    await tx.sceneGeneration.updateMany({
      where: { workspaceId: context.workspaceId, id: next.id },
      data: {
        status: success
          ? "SUCCEEDED"
          : statuses.includes("FAILED_RETRYABLE")
            ? "FAILED_RETRYABLE"
            : "FAILED_FINAL",
      },
    });
    return next;
  }
  private async rollup(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    jobId: string,
  ): Promise<void> {
    const active = await tx.sceneGeneration.findMany({
      where: { workspaceId: context.workspaceId, jobId, activeSlot: 1 },
    });
    await tx.sceneMediaJob.updateMany({
      where: { workspaceId: context.workspaceId, id: jobId },
      data: {
        status: active.every((item) => item.status === "SUCCEEDED")
          ? "SUCCEEDED"
          : active.some((item) => item.status === "SUCCEEDED")
            ? "PARTIAL"
            : "FAILED",
      },
    });
  }
  private async record(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    input: ReturnType<typeof parseAssignAssetInput>,
    hash: string,
    before: Prisma.SceneGenerationGetPayload<object>[],
    next: Prisma.SceneGenerationGetPayload<object>,
  ): Promise<void> {
    await tx.sceneMediaMutation.create({
      data: {
        workspaceId: context.workspaceId,
        jobId,
        operation: "ASSIGN_ASSET",
        status: "SUCCEEDED",
        idempotencyKey: input.idempotencyKey,
        expectedJobVersion: input.expectedJobVersion,
        payloadHash: hash,
        payload: { sceneId, ...input },
        sceneIds: [sceneId],
        sceneVersionBefore: Math.max(...before.map((item) => item.sceneVersion)),
        sceneVersionAfter: Math.max(next.sceneVersion, ...before.map((item) => item.sceneVersion)),
        createdByUserId: context.userId,
      },
    });
  }
  private async copyOutput(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    generationId: string,
    output: Prisma.SceneGenerationOutputGetPayload<object>,
    kind: string,
    asset: Prisma.AssetGetPayload<object>,
  ): Promise<string> {
    const assigned = output.kind === kind;
    const id = randomUUID();
    const ready = ["SUCCEEDED", "ASSIGNED", "REUSED"].includes(output.status);
    const row = await tx.sceneGenerationOutput.create({
      data: {
        workspaceId: context.workspaceId,
        id,
        sceneGenerationId: generationId,
        kind: output.kind,
        status: assigned ? "ASSIGNED" : ready ? "REUSED" : output.status,
        assetId: assigned ? asset.id : output.assetId,
        assetVersion: assigned ? asset.version : output.assetVersion,
        mediaType: assigned ? asset.mediaType : output.mediaType,
        byteSize: assigned ? asset.byteSize : output.byteSize,
        checksumSha256: assigned ? asset.checksumSha256 : output.checksumSha256,
        reusedFromOutputId: assigned ? null : output.id,
        providerJobId: assigned ? null : output.providerJobId,
        providerAssetId: assigned ? null : output.providerAssetId,
        errorCode: assigned ? null : output.errorCode,
        errorMessage: assigned ? null : output.errorMessage,
      },
    });
    if (row.assetId && row.assetVersion)
      await tx.assetUsageReference.create({
        data: {
          workspaceId: context.workspaceId,
          assetId: row.assetId,
          assetVersion: row.assetVersion,
          usedByType: "scene_generation_output",
          usedById: id,
          context: { generationId, kind, assigned },
        },
      });
    return row.status;
  }
}
