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
import { Prisma } from "@reelforge/database";
import { canonicalRenderFingerprint } from "@reelforge/media";
import { createHash } from "node:crypto";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionEnginePort } from "./composition.engine.js";
import { COMPOSITION_ENGINE } from "./composition.types.js";
import type {
  RenderArtifactView,
  RenderCompositionInput,
  RenderJobView,
} from "./composition.types.js";
import {
  createRenderSchema,
  duration,
  editRenderSchema,
  parse,
  validateComposition,
} from "./composition.validation.js";

@Injectable()
export class CompositionService {
  private readonly active = new Map<string, AbortController>();
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(COMPOSITION_ENGINE) private readonly engine: CompositionEnginePort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  public async create(context: WorkspaceContext, body: unknown): Promise<RenderJobView> {
    this.editor(context);
    const parsed = parse(createRenderSchema, body);
    try {
      return await this.start(
        context,
        null,
        parsed.idempotencyKey,
        parsed.retentionDays,
        parsed.input,
      );
    } catch (error) {
      if (isUnique(error))
        return this.present(
          context,
          await this.existingId(context.workspaceId, parsed.idempotencyKey),
        );
      throw error;
    }
  }
  public async get(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    return this.present(context, id);
  }
  public async getManifest(context: WorkspaceContext, id: string): Promise<unknown> {
    const job = await this.present(context, id);
    const artifact = job.artifacts.find((item) => item.kind === "MANIFEST");
    if (job.status !== "SUCCEEDED" || !artifact)
      throw new ConflictException("A successful render and validated manifest are required");
    return JSON.parse(
      (
        await this.storage.getObject({
          workspaceId: context.workspaceId,
          objectKey: artifact.objectKey,
        })
      ).toString("utf8"),
    );
  }
  public async cancel(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    this.editor(context);
    await this.require(context, id);
    const rows = await this.db.renderJob.updateMany({
      where: { workspaceId: context.workspaceId, id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { cancelRequestedAt: new Date() },
    });
    if (rows.count === 0) throw new ConflictException("A terminal render cannot be canceled");
    this.active.get(id)?.abort();
    return this.present(context, id);
  }
  public async retry(context: WorkspaceContext, id: string, body: unknown): Promise<RenderJobView> {
    this.editor(context);
    const job = await this.require(context, id);
    if (job.status !== "FAILED_RETRYABLE")
      throw new ConflictException("Only a failed retryable render can be retried");
    const parsed = parse(createRenderSchema, body);
    if (
      canonicalRenderFingerprint(parsed.input) !== job.inputFingerprint ||
      parsed.input.sourceMediaPackage.jobId !== job.sceneMediaJobId
    )
      throw new ConflictException(
        "Retry must exactly replay the failed pinned input and render profile",
      );
    return this.start(context, id, parsed.idempotencyKey, parsed.retentionDays, parsed.input);
  }
  public async edit(context: WorkspaceContext, id: string, body: unknown): Promise<RenderJobView> {
    this.editor(context);
    const parent = await this.require(context, id);
    if (parent.status !== "SUCCEEDED")
      throw new ConflictException("Bounded edits require a successful parent render");
    const parsed = parse(editRenderSchema, body);
    const input = structuredClone(
      parse(createRenderSchema, {
        idempotencyKey: "snapshot",
        retentionDays: parent.retentionDays,
        input: parent.input,
      }).input,
    );
    const operation = parsed.operation;
    if (operation.kind === "REPLACE_TITLE") Object.assign(input, { title: operation.title });
    if (operation.kind === "REPLACE_COVER")
      Object.assign(input, { coverFrames: operation.coverFrames });
    if (operation.kind === "REPLACE_SCENE") {
      const index = input.scenes.findIndex((scene) => scene.sceneId === operation.sceneId);
      if (index < 0) throw new NotFoundException("Composition scene not found");
      if (operation.scene.sceneId !== operation.sceneId)
        throw new BadRequestException("Scene identity cannot change during a bounded scene edit");
      input.scenes[index] = operation.scene;
    }
    if (operation.kind === "REPLACE_SUBTITLE") {
      const scene = input.scenes.find((item) => item.sceneId === operation.sceneId);
      if (!scene) throw new NotFoundException("Composition scene not found");
      Object.assign(scene, { captions: operation.captions });
    }
    if (operation.kind === "REPLACE_AUDIO") {
      if (operation.index >= input.audio.length)
        throw new NotFoundException("Composition audio input not found");
      input.audio[operation.index] = operation.audio;
    }
    validateComposition(input);
    return this.start(context, id, parsed.idempotencyKey, parsed.retentionDays, input);
  }
  private async start(
    context: WorkspaceContext,
    parentId: string | null,
    idempotencyKey: string,
    retentionDays: number,
    raw: RenderCompositionInput,
  ): Promise<RenderJobView> {
    if (parentId === null) {
      const repeated = await this.db.renderJob.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: context.workspaceId, idempotencyKey } },
        select: { id: true },
      });
      if (repeated) return this.present(context, repeated.id);
    }
    const input = parse(createRenderSchema, {
      idempotencyKey: "validate",
      retentionDays,
      input: raw,
    }).input;
    validateComposition(input);
    await this.assertPackage(context, input);
    let jobId = randomUUID();
    try {
      await this.db.renderJob.create({
        data: {
          id: jobId,
          workspaceId: context.workspaceId,
          sceneMediaJobId: input.sourceMediaPackage.jobId,
          parentJobId: parentId,
          idempotencyKey,
          status: "QUEUED",
          attempt: parentId === null ? 0 : await this.nextAttempt(context, parentId),
          input: input as Prisma.InputJsonValue,
          inputFingerprint: canonicalRenderFingerprint(input),
          retentionDays,
          createdByUserId: context.userId,
        },
      });
    } catch (error) {
      if (isUnique(error))
        return this.present(context, await this.existingId(context.workspaceId, idempotencyKey));
      throw error;
    }
    // Atomic claim prevents a concurrent retry from running the same render twice.
    const claim = await this.db.renderJob.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id: jobId,
        status: { in: ["QUEUED", "FAILED_RETRYABLE"] },
        cancelRequestedAt: null,
      },
      data: { status: "RUNNING", errorCode: null, errorMessage: null },
    });
    if (claim.count === 0) return this.present(context, jobId);
    const controller = new AbortController();
    this.active.set(jobId, controller);
    try {
      const artifacts = await this.engine.execute(context, jobId, input, controller.signal);
      if (controller.signal.aborted) throw canceled();
      const manifest = artifacts.find((artifact) => artifact.kind === "MANIFEST");
      const video = artifacts.find((artifact) => artifact.kind === "VIDEO");
      const pictures = artifacts.filter((artifact) => artifact.kind === "COVER");
      if (
        !manifest ||
        !video ||
        pictures.length !== input.coverFrames.length ||
        artifacts.length !== input.coverFrames.length + 2
      )
        throw new Error("Validated render is missing video, cover, or manifest artifacts");
      const retainedUntil = new Date(Date.now() + retentionDays * 86400000);
      const insertResults: Array<{
        kind: "VIDEO" | "MANIFEST" | "COVER";
        assetId: string;
        objectKey: string;
      }> = [];
      for (const artifact of artifacts) {
        const assetId = randomUUID();
        const objectKey = `render/${jobId}/${artifact.filename}`;
        insertResults.push({ kind: artifact.kind, assetId, objectKey });
      }
      const manifestResult = insertResults.find((item) => item.kind === "MANIFEST")!;
      const videoResult = insertResults.find((item) => item.kind === "VIDEO")!;
      const covers = insertResults.filter((item) => item.kind === "COVER");
      const manifestParsed = JSON.parse(manifest.body.toString("utf8")) as Record<string, unknown>;
      manifestParsed.video = {
        ...(manifestParsed.video as Record<string, unknown>),
        artifactId: videoResult.assetId,
        objectKey: videoResult.objectKey,
      };
      manifestParsed.covers = input.coverFrames.map((frame, index) => ({
        ...frame,
        artifactId: covers[index]!.assetId,
        objectKey: covers[index]!.objectKey,
      }));
      const manifestBytes = Buffer.from(JSON.stringify(manifestParsed, null, 2) + "\n");
      const artifactByKind = insertResults.map((result) => ({
        result,
        artifact:
          result.kind === "VIDEO"
            ? video
            : result.kind === "MANIFEST"
              ? manifest
              : pictures[covers.indexOf(result)]!,
      }));
      for (const { result, artifact } of artifactByKind) {
        const body = result.kind === "MANIFEST" ? manifestBytes : artifact.body;
        const verification = await this.storage.putObject({
          workspaceId: context.workspaceId,
          objectKey: result.objectKey,
          body,
          contentType: artifact.mediaType,
        });
        if (
          verification.checksumSha256 !== checksum(body) ||
          verification.byteSize !== body.length
        ) {
          for (const cleanup of artifactByKind)
            await this.storage
              .deleteObject({
                workspaceId: context.workspaceId,
                objectKey: cleanup.result.objectKey,
              })
              .catch(() => undefined);
          throw new Error("Stored render checksum or size mismatch");
        }
      }
      try {
        await this.db.$transaction(async (tx) => {
          const current = await tx.renderJob.findUnique({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
            select: { cancelRequestedAt: true },
          });
          if (!current || current.cancelRequestedAt !== null || controller.signal.aborted)
            throw canceled();
          for (const { result, artifact } of artifactByKind) {
            const body = result.kind === "MANIFEST" ? manifestBytes : artifact.body;
            await tx.asset.create({
              data: {
                id: result.assetId,
                workspaceId: context.workspaceId,
                objectKey: result.objectKey,
                mediaType: artifact.mediaType,
                filename: artifact.filename,
                byteSize: body.length,
                checksumSha256: checksum(body),
                version: 1,
                rootAssetId: result.assetId,
                ownership: "SYSTEM_GENERATED",
                status: "PUBLISHED",
                licenseType: "generated",
                licenseTerms: "Generated composition output for this workspace",
                rightsHolder: "ReelForge",
                rightsAttestedAt: new Date(),
                createdByUserId: context.userId,
              },
            });
            await tx.renderArtifact.create({
              data: {
                id: result.assetId,
                workspaceId: context.workspaceId,
                renderJobId: jobId,
                kind: result.kind,
                assetId: result.assetId,
                assetVersion: 1,
                objectKey: result.objectKey,
                mediaType: artifact.mediaType,
                byteSize: body.length,
                checksumSha256: checksum(body),
                metadata:
                  artifact.kind === "VIDEO"
                    ? { durationMs: artifact.durationMs, outputProfile: input.profile }
                    : artifact.selectedFrame
                      ? { selectedFrame: artifact.selectedFrame }
                      : Prisma.JsonNull,
                retainedUntil,
              },
            });
            await tx.assetUsageReference.create({
              data: {
                workspaceId: context.workspaceId,
                assetId: result.assetId,
                assetVersion: 1,
                usedByType: "render_artifact",
                usedById: result.assetId,
                context: { jobId, kind: result.kind },
              },
            });
          }
          for (const scene of input.scenes) {
            await tx.assetUsageReference.create({
              data: {
                workspaceId: context.workspaceId,
                assetId: scene.assetId,
                assetVersion: scene.assetVersion,
                usedByType: "render_input",
                usedById: jobId,
                context: { sceneId: scene.sceneId, kind: "VISUAL" },
              },
            });
            if (scene.narrationAssetId && scene.narrationAssetVersion)
              await tx.assetUsageReference.create({
                data: {
                  workspaceId: context.workspaceId,
                  assetId: scene.narrationAssetId,
                  assetVersion: scene.narrationAssetVersion,
                  usedByType: "render_input",
                  usedById: jobId,
                  context: { sceneId: scene.sceneId, kind: "NARRATION" },
                },
              });
          }
          for (const audio of input.audio)
            await tx.assetUsageReference.create({
              data: {
                workspaceId: context.workspaceId,
                assetId: audio.assetId,
                assetVersion: audio.assetVersion,
                usedByType: "render_input",
                usedById: jobId,
                context: { kind: audio.kind },
              },
            });
          await tx.renderJob.update({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
            data: { status: "SUCCEEDED", errorCode: null, errorMessage: null },
          });
        });
        return this.present(context, jobId);
      } finally {
        const successful = await this.db.renderJob.findUnique({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
          select: { status: true },
        });
        if (successful?.status !== "SUCCEEDED")
          await Promise.all(
            artifactByKind.map(({ result }) =>
              this.storage
                .deleteObject({ workspaceId: context.workspaceId, objectKey: result.objectKey })
                .catch(() => undefined),
            ),
          );
      }
    } catch (error) {
      await this.db.renderJob.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
        data: {
          status: isCancellation(error, controller.signal) ? "CANCELED" : "FAILED_RETRYABLE",
          errorCode: isCancellation(error, controller.signal) ? "CANCELED" : errorCode(error),
          errorMessage: safeMessage(error),
        },
      });
      throw isCancellation(error, controller.signal)
        ? new ConflictException("Render was canceled")
        : toHttp(error);
    } finally {
      this.active.delete(jobId);
    }
  }
  private async assertPackage(
    context: WorkspaceContext,
    input: RenderCompositionInput,
  ): Promise<void> {
    const pkg = await this.db.sceneMediaJob.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: input.sourceMediaPackage.jobId },
      },
      include: { scenes: { where: { activeSlot: 1 }, include: { outputs: true } } },
    });
    if (!pkg) throw new NotFoundException("Scene media package not found");
    if (
      pkg.status !== "SUCCEEDED" ||
      pkg.schemaVersion !== "1.0" ||
      pkg.scriptId !== input.sourceMediaPackage.scriptId ||
      pkg.scriptRevision !== input.sourceMediaPackage.scriptRevision
    )
      throw new ConflictException(
        "Only the pinned successful M09 schema 1.0 package can be composed",
      );
    if (
      pkg.scenes.length === 0 ||
      pkg.scenes.some(
        (scene) =>
          scene.status !== "SUCCEEDED" ||
          scene.outputs.some(
            (output) => output.status !== "SUCCEEDED" && output.status !== "REUSED",
          ),
      )
    )
      throw new ConflictException("Failed or incomplete scene media cannot be composed");
    for (const scene of input.scenes) {
      const approved = pkg.scenes.find((candidate) => candidate.sceneId === scene.sceneId);
      if (!approved)
        throw new ConflictException(
          "Composition scene is not in the pinned successful M09 package",
        );
      const outputs = approved.outputs.filter(
        (output) => output.status === "SUCCEEDED" || output.status === "REUSED",
      );
      const visual = outputs.find(
        (output) =>
          output.assetId === scene.assetId &&
          output.assetVersion === scene.assetVersion &&
          (output.kind === "VIDEO" || output.kind === "IMAGE"),
      );
      if (!visual)
        throw new ConflictException("Every scene must use a pinned successful visual from M09");
      if ((visual.kind === "IMAGE") !== scene.image)
        throw new ConflictException("Composition image flag must match M09 visual media");
      if (scene.narrationAssetId) {
        const narration = outputs.find(
          (output) =>
            output.assetId === scene.narrationAssetId &&
            output.assetVersion === scene.narrationAssetVersion &&
            (output.kind === "NARRATION" || output.kind === "DIALOGUE"),
        );
        if (!narration)
          throw new ConflictException("Narration must be a pinned successful M09 output");
      }
    }
  }
  private async nextAttempt(context: WorkspaceContext, parentId: string): Promise<number> {
    let id: string | null = parentId;
    let attempt = 0;
    const ancestry = new Set<string>();
    while (id) {
      if (ancestry.has(id)) throw new ConflictException("Render ancestry contains a cycle");
      ancestry.add(id);
      const job: { parentJobId: string | null; attempt: number } | null =
        await this.db.renderJob.findUnique({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
          select: { parentJobId: true, attempt: true },
        });
      if (!job) throw new NotFoundException("Parent render not found");
      attempt = Math.max(attempt, job.attempt);
      id = job.parentJobId;
    }
    return attempt + 1;
  }
  private async present(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { artifacts: { orderBy: { createdAt: "asc" } } },
    });
    if (!job) throw new NotFoundException("Render job not found");
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
    };
  }
  private async require(context: WorkspaceContext, id: string) {
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: {
        id: true,
        status: true,
        sceneMediaJobId: true,
        inputFingerprint: true,
        retentionDays: true,
        input: true,
      },
    });
    if (!job) throw new NotFoundException("Render job not found");
    return job;
  }
  private async existingId(workspaceId: string, idempotencyKey: string): Promise<string> {
    const existing = await this.db.renderJob.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      select: { id: true },
    });
    if (!existing) throw new ConflictException("Idempotent render could not be retrieved");
    return existing.id;
  }
  private editor(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }
}
function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
function canceled(): Error {
  return Object.assign(new Error("Render canceled"), { name: "AbortError" });
}
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
function errorCode(error: unknown): string {
  return error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
    ? "INVALID_RENDER"
    : error instanceof ServiceUnavailableException
      ? "RENDER_UNAVAILABLE"
      : "RENDER_FAILED";
}
function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : "Composition failed";
}
function toHttp(error: unknown): Error {
  return error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof ServiceUnavailableException
    ? error
    : new ServiceUnavailableException("Composition failed; no successful export was created", {
        cause: error,
      });
}
function isUnique(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
