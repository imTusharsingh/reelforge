import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { renderRetryDelayMs } from "./composition.retry-policy.js";
import type { RenderManifest } from "./composition.manifest.js";

import { canonicalRenderFingerprint, MediaValidationError } from "@reelforge/media";
import { createHash } from "node:crypto";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionEnginePort } from "./composition.engine.js";
import { AssetService } from "../asset/asset.service.js";
import { COMPOSITION_ENGINE } from "./composition.types.js";
import type {
  RenderArtifactView,
  RenderCompositionInput,
  RenderJobView,
} from "./composition.types.js";
import {
  validateEngineManifest,
  validateManifestArtifactReferences,
  validateStoredManifest,
} from "./composition.manifest.js";
import {
  createRenderSchema,
  editRenderSchema,
  parse,
  validateComposition,
} from "./composition.validation.js";

export type CompositionClock = { readonly now: () => Date };
export const COMPOSITION_CLOCK = "COMPOSITION_CLOCK";

@Injectable()
export class CompositionService {
  private readonly active = new Map<string, AbortController>();
  private readonly now: () => Date;
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(COMPOSITION_ENGINE) private readonly engine: CompositionEnginePort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly assets: AssetService,
    @Optional()
    @Inject(COMPOSITION_CLOCK)
    options: CompositionClock = {
      now: () => new Date(),
    },
  ) {
    this.now = options.now;
  }
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
          await this.existingId(
            context.workspaceId,
            parsed.idempotencyKey,
            canonicalRenderFingerprint(parsed.input),
            parsed.retentionDays,
            null,
          ),
        );
      throw error;
    }
  }
  public async get(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    return this.present(context, id);
  }
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
  public async cancel(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    this.editor(context);
    const rows = await this.db.renderJob.updateMany({
      where: { workspaceId: context.workspaceId, id, status: "QUEUED" },
      data: {
        status: "CANCELED",
        cancelRequestedAt: new Date(),
        errorCode: "CANCELED",
        errorMessage: "Canceled before execution",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (rows.count === 0) {
      const running = await this.db.renderJob.updateMany({
        where: { workspaceId: context.workspaceId, id, status: "RUNNING" },
        data: {
          cancelRequestedAt: new Date(),
          status: "CANCELED",
          errorCode: "CANCELED",
          errorMessage: "Canceled during execution",
        },
      });
      if (running.count === 0) throw new ConflictException("A terminal render cannot be canceled");
    }
    this.active.get(id)?.abort();
    return this.present(context, id);
  }
  public async retry(context: WorkspaceContext, id: string, body: unknown): Promise<RenderJobView> {
    this.editor(context);
    const job = await this.require(context, id);
    const request = parse(createRenderSchema, body);
    const fingerprint = canonicalRenderFingerprint(request.input);
    if (
      fingerprint !== job.inputFingerprint ||
      request.input.sourceMediaPackage.jobId !== job.sceneMediaJobId
    )
      throw new ConflictException(
        "Retry must exactly replay the failed pinned input and render profile",
      );
    const existing = await this.db.renderJob.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: context.workspaceId,
          idempotencyKey: request.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (existing)
      return this.present(
        context,
        await this.existingId(
          context.workspaceId,
          request.idempotencyKey,
          fingerprint,
          request.retentionDays,
          id,
        ),
      );
    if (!["FAILED_RETRYABLE", "CANCELED"].includes(job.status))
      throw new ConflictException("Only a failed retryable or canceled render can be retried");
    if (job.attempt >= job.maxRetries)
      throw new ConflictException("The render retry limit has been exhausted; start a new render");
    validateComposition(request.input);
    await this.assertPackage(context, request.input);
    const childId = randomUUID();
    try {
      await this.db.$transaction(async (tx) => {
        const parent = await tx.renderJob.findUnique({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
          select: { status: true, attempt: true, maxRetries: true },
        });
        if (!parent || !["FAILED_RETRYABLE", "CANCELED"].includes(parent.status))
          throw new ConflictException("The parent render is no longer retryable");
        if (parent.attempt >= parent.maxRetries)
          throw new ConflictException(
            "The render retry limit has been exhausted; start a new render",
          );
        // Atomically consume the shared retry budget. A retryable parent is
        // superseded so the worker cannot also auto-retry it; a canceled parent
        // stays canceled but still consumes one attempt from the same budget.
        const consumed = await tx.renderJob.updateMany({
          where: { id, status: parent.status, attempt: parent.attempt },
          data: {
            attempt: { increment: 1 },
            ...(parent.status === "FAILED_RETRYABLE"
              ? {
                  status: "FAILED_FINAL",
                  errorCode: "RETRY_SUPERSEDED",
                  errorMessage: "Superseded by an explicit retry child",
                  nextAttemptAt: this.now(),
                }
              : {}),
          },
        });
        if (consumed.count !== 1)
          throw new ConflictException("The parent render was already retried or claimed");
        await tx.renderJob.create({
          data: {
            id: childId,
            workspaceId: context.workspaceId,
            sceneMediaJobId: request.input.sourceMediaPackage.jobId,
            parentJobId: id,
            idempotencyKey: request.idempotencyKey,
            status: "QUEUED",
            attempt: parent.attempt + 1,
            input: request.input as Prisma.InputJsonValue,
            inputFingerprint: fingerprint,
            retentionDays: request.retentionDays,
            createdByUserId: context.userId,
          },
        });
      });
    } catch (error) {
      if (isUnique(error))
        return this.present(
          context,
          await this.existingId(
            context.workspaceId,
            request.idempotencyKey,
            fingerprint,
            request.retentionDays,
            id,
          ),
        );
      throw error;
    }
    const claimed = await this.claim(childId, 15 * 60 * 1000, false);
    if (!claimed) return this.present(context, childId);
    await this.afterClaim(childId);
    return this.executeClaimed(claimed, 15 * 60 * 1000);
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
  public async claimForExecution(jobId: string, leaseMs = 30_000): Promise<boolean> {
    return (await this.claim(jobId, leaseMs)) !== null;
  }

  public async runClaim(jobId: string, leaseMs = 15 * 60 * 1000): Promise<RenderJobView | null> {
    const candidate = await this.db.renderJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        attempt: true,
        maxRetries: true,
        leaseToken: true,
        leaseExpiresAt: true,
        nextAttemptAt: true,
      },
    });
    if (!candidate) return null;
    const now = this.now();
    const leaseExpired =
      candidate.leaseToken === null ||
      candidate.leaseExpiresAt === null ||
      candidate.leaseExpiresAt <= now;
    const queued = candidate.status === "QUEUED";
    const retryable = candidate.status === "FAILED_RETRYABLE";
    const staleRunning = candidate.status === "RUNNING" && leaseExpired;
    if (!queued && !retryable && !staleRunning) return null;
    if (!staleRunning && candidate.nextAttemptAt > now) return null;
    if (
      queued ? candidate.attempt > candidate.maxRetries : candidate.attempt >= candidate.maxRetries
    ) {
      await this.exhaustRetries(
        jobId,
        queued ? "QUEUED" : retryable ? "FAILED_RETRYABLE" : "RUNNING",
      );
      return null;
    }
    const claim = await this.claimScheduled(jobId, leaseMs, candidate.maxRetries);
    if (!claim) return null;
    await this.afterClaim(jobId);
    try {
      return await this.executeClaimed(claim, leaseMs);
    } catch (error) {
      const state = await this.db.renderJob.findUnique({
        where: { id: claim.id },
        select: { status: true },
      });
      if (state !== null)
        return this.present(
          { workspaceId: claim.workspaceId, userId: claim.createdByUserId, role: "OWNER" },
          claim.id,
        );
      throw error;
    }
  }

  private async claimScheduled(
    jobId: string,
    leaseMs: number,
    maxRetries: number,
  ): Promise<ClaimedRender | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.now();
      const claimToken = randomUUID();
      const claimed = await this.db.$transaction(async (tx): Promise<ClaimedRender | null> => {
        const canceled = await tx.renderJob.updateMany({
          where: {
            id: jobId,
            status: { in: ["QUEUED", "FAILED_RETRYABLE"] },
            cancelRequestedAt: { not: null },
          },
          data: {
            status: "CANCELED",
            errorCode: "CANCELED",
            errorMessage: "Canceled before execution",
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (canceled.count === 1) return null;
        const queued = await tx.renderJob.updateMany({
          where: {
            id: jobId,
            status: "QUEUED",
            cancelRequestedAt: null,
            nextAttemptAt: { lte: now },
            attempt: { lte: maxRetries },
            OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
          },
          data: {
            status: "RUNNING",
            leaseToken: claimToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            errorCode: null,
            errorMessage: null,
            attempt: { increment: 1 },
            scheduledAttempts: { increment: 1 },
          },
        });
        const result =
          queued.count === 1
            ? queued
            : await tx.renderJob.updateMany({
                where: {
                  id: jobId,
                  status: { in: ["FAILED_RETRYABLE", "RUNNING"] },
                  cancelRequestedAt: null,
                  attempt: { lt: maxRetries },
                  OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
                },
                data: {
                  status: "RUNNING",
                  leaseToken: claimToken,
                  leaseExpiresAt: new Date(now.getTime() + leaseMs),
                  errorCode: null,
                  errorMessage: null,
                  attempt: { increment: 1 },
                  scheduledAttempts: { increment: 1 },
                },
              });
        if (result.count !== 1) return null;
        const row = await tx.renderJob.findUnique({ where: { id: jobId } });
        if (
          !row ||
          row.cancelRequestedAt ||
          row.status !== "RUNNING" ||
          row.leaseToken !== claimToken
        ) {
          await tx.renderJob.updateMany({
            where: { id: jobId, leaseToken: claimToken },
            data: {
              status: "CANCELED",
              cancelRequestedAt: now,
              errorCode: "CANCELED",
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return null;
        }
        this.active.get(jobId)?.abort();
        return row as unknown as ClaimedRender;
      });
      if (claimed || attempt === 2) return claimed;
    }
    return null;
  }

  private async exhaustRetries(
    jobId: string,
    status: "QUEUED" | "FAILED_RETRYABLE" | "RUNNING",
  ): Promise<void> {
    const expiredLease =
      status === "RUNNING"
        ? { OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: this.now() } }] }
        : {};
    const canceled = await this.db.renderJob.updateMany({
      where: { id: jobId, status, cancelRequestedAt: { not: null }, ...expiredLease },
      data: {
        status: "CANCELED",
        errorCode: "CANCELED",
        errorMessage: "Canceled before execution",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (canceled.count === 1) return;
    await this.db.renderJob.updateMany({
      where: { id: jobId, status, ...expiredLease },
      data: {
        status: "FAILED_FINAL",
        errorCode: "RETRY_EXHAUSTED",
        errorMessage: "Automatic retry limit exhausted",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }

  public async runScheduled(
    batch = 10,
    jobId?: string,
  ): Promise<{ claimed: number; retained: number }> {
    const jobs = await this.db.renderJob.findMany({
      where: {
        expiredAt: null,
        OR: [
          {
            status: { in: ["QUEUED", "FAILED_RETRYABLE"] },
            nextAttemptAt: { lte: this.now() },
            OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: this.now() } }],
          },
          { status: "RUNNING", OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: this.now() } }] },
        ],
        ...(jobId === undefined ? {} : { id: jobId }),
      },
      orderBy: { nextAttemptAt: "asc" },
      take: batch,
      select: { id: true },
    });
    let claimed = 0;
    for (const job of jobs) {
      const view = await this.runClaim(job.id);
      if (view) claimed++;
    }
    return { claimed, retained: await this.expireRetainedOutputs(batch) };
  }

  public async expireRetainedOutputs(batch = 100): Promise<number> {
    const jobs = await this.db.renderJob.findMany({
      where: { expiredAt: null, artifacts: { some: { retainedUntil: { lte: this.now() } } } },
      take: batch,
      select: { id: true },
    });
    let removed = 0;
    for (const { id } of jobs) {
      const retentionToken = randomUUID();
      const claimed = await this.db.renderJob.updateMany({
        where: {
          id,
          expiredAt: null,
          status: "SUCCEEDED",
          OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: this.now() } }],
        },
        data: {
          leaseToken: retentionToken,
          leaseExpiresAt: new Date(this.now().getTime() + 60000),
        },
      });
      if (claimed.count !== 1) continue;
      const artifacts = await this.db.renderArtifact.findMany({ where: { renderJobId: id } });
      try {
        for (const artifact of artifacts) {
          // Deletion is intentionally idempotent: a previous retention pass may
          // have removed some objects before failing, and those rows must not
          // make the expiry permanently unrecoverable.
          await this.storage.deleteObject({
            workspaceId: artifact.workspaceId,
            objectKey: artifact.objectKey,
          });
          removed++;
        }
        await this.db.renderJob.updateMany({
          where: { id, leaseToken: retentionToken },
          data: { expiredAt: this.now(), leaseToken: null, leaseExpiresAt: null },
        });
      } catch (error) {
        await this.db.renderJob.updateMany({
          where: { id, leaseToken: retentionToken },
          data: { leaseToken: null, leaseExpiresAt: null },
        });
        throw new ServiceUnavailableException(
          "Output retention deletion did not complete; expiry will be retried",
          { cause: error },
        );
      }
    }
    return removed;
  }

  private async claim(
    jobId: string,
    leaseMs: number,
    scheduled = true,
  ): Promise<ClaimedRender | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.now();
      const claimToken = randomUUID();
      const claimed = await this.db.$transaction(async (tx): Promise<ClaimedRender | null> => {
        const terminal = await tx.renderJob.updateMany({
          where: { id: jobId, status: "QUEUED", cancelRequestedAt: { not: null } },
          data: {
            status: "CANCELED",
            errorCode: "CANCELED",
            errorMessage: "Canceled before execution",
          },
        });
        if (terminal.count === 1) return null;
        const result = await tx.renderJob.updateMany({
          where: {
            id: jobId,
            status: { in: ["QUEUED", "RUNNING", "FAILED_RETRYABLE"] },
            cancelRequestedAt: null,
            nextAttemptAt: { lte: now },
            ...(scheduled ? { scheduledAttempts: { lte: 3 } } : {}),
            OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
          },
          data: {
            status: "RUNNING",
            leaseToken: claimToken,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
            errorCode: null,
            errorMessage: null,
          },
        });
        if (result.count !== 1) return null;
        const row = await tx.renderJob.findUnique({ where: { id: jobId } });
        if (
          !row ||
          row.cancelRequestedAt ||
          row.status !== "RUNNING" ||
          row.leaseToken !== claimToken
        ) {
          await tx.renderJob.updateMany({
            where: { id: jobId, leaseToken: claimToken },
            data: {
              status: "CANCELED",
              cancelRequestedAt: now,
              errorCode: "CANCELED",
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return null;
        }
        this.active.get(jobId)?.abort();
        return row as unknown as ClaimedRender;
      });
      if (claimed || attempt === 2) return claimed;
    }
    return null;
  }

  private async start(
    context: WorkspaceContext,
    parentId: string | null,
    idempotencyKey: string,
    retentionDays: number,
    raw: RenderCompositionInput,
  ): Promise<RenderJobView> {
    const input = parse(createRenderSchema, {
      idempotencyKey: "validate",
      retentionDays,
      input: raw,
    }).input;
    validateComposition(input);
    if (parentId === null) {
      const repeated = await this.db.renderJob.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: context.workspaceId, idempotencyKey } },
        select: { id: true, inputFingerprint: true, retentionDays: true, parentJobId: true },
      });
      if (repeated) {
        if (
          repeated.parentJobId !== parentId ||
          repeated.inputFingerprint !== canonicalRenderFingerprint(input) ||
          repeated.retentionDays !== retentionDays
        )
          throw new ConflictException(
            "The same idempotency key requires identical render input and retention",
          );
        return this.present(context, repeated.id);
      }
    }
    await this.assertPackage(context, input);
    const jobId = randomUUID();
    try {
      await this.db.renderJob.create({
        data: {
          id: jobId,
          workspaceId: context.workspaceId,
          sceneMediaJobId: input.sourceMediaPackage.jobId,
          parentJobId: parentId,
          idempotencyKey,
          status: "QUEUED",
          attempt: parentId === null ? 0 : (await this.require(context, parentId)).attempt + 1,
          input: input as Prisma.InputJsonValue,
          inputFingerprint: canonicalRenderFingerprint(input),
          retentionDays,
          createdByUserId: context.userId,
        },
      });
    } catch (error) {
      if (isUnique(error))
        return this.present(
          context,
          await this.existingId(
            context.workspaceId,
            idempotencyKey,
            canonicalRenderFingerprint(input),
            retentionDays,
            parentId,
          ),
        );
      throw error;
    }
    const claimed = await this.claim(jobId, 15 * 60 * 1000, false);
    if (!claimed) return this.present(context, jobId);
    await this.afterClaim(claimed.id);
    return this.executeClaimed(claimed, 15 * 60 * 1000);
  }

  protected async afterClaim(jobId: string): Promise<void> {
    void jobId;
  }
  private async executeClaimed(
    claimed: ClaimedRender,
    leaseMs = 15 * 60 * 1000,
  ): Promise<RenderJobView> {
    const { id: jobId, input } = claimed;
    const leaseToken = claimed.leaseToken;
    const context: WorkspaceContext = {
      workspaceId: claimed.workspaceId,
      userId: claimed.createdByUserId,
      role: "OWNER",
    };
    const controller = new AbortController();
    const outputKeys: string[] = [];
    let committed = false;
    this.active.set(jobId, controller);
    const heartbeat = setInterval(
      () => {
        void this.db.renderJob
          .updateMany({
            where: {
              id: jobId,
              status: "RUNNING",
              leaseToken,
              cancelRequestedAt: null,
            },
            data: { leaseExpiresAt: new Date(this.now().getTime() + leaseMs) },
          })
          .then(({ count }) => {
            if (count === 0) controller.abort();
          })
          .catch(() => undefined);
      },
      Math.max(1000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const cancelRequested = await this.db.renderJob.findFirst({
        where: { id: jobId, leaseToken, cancelRequestedAt: { not: null } },
        select: { id: true },
      });
      if (cancelRequested) throw canceled();
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
      const retainedUntil = new Date(this.now().getTime() + claimed.retentionDays * 86400000);
      const insertResults: Array<{
        kind: "VIDEO" | "MANIFEST" | "COVER";
        id: string;
        assetId: string;
        objectKey: string;
      }> = [];
      for (const artifact of artifacts) {
        const assetId = randomUUID();
        // Claim-specific keys ensure a superseded executor cannot overwrite
        // artifacts published by the worker that recovered its expired lease.
        const objectKey = `render/${jobId}/${leaseToken}/${artifact.filename}`;
        outputKeys.push(objectKey);
        insertResults.push({
          kind: artifact.kind,
          id: assetId,
          assetId,
          objectKey,
        });
      }
      const videoResult = insertResults.find((item) => item.kind === "VIDEO")!;
      const covers = insertResults.filter((item) => item.kind === "COVER");
      const manifestParsed = validateEngineManifest(
        manifest.body,
        input,
        jobId,
        video,
        pictures,
      ) as unknown as Record<string, unknown>;
      manifestParsed.video = {
        ...(manifestParsed.video as Record<string, unknown>),
        artifactId: videoResult.id,
        objectKey: videoResult.objectKey,
      };
      manifestParsed.covers = input.coverFrames.map((frame, index) => ({
        artifactId: covers[index]!.id,
        objectKey: covers[index]!.objectKey,
        checksumSha256: checksum(pictures[index]!.body),
        byteSize: pictures[index]!.body.length,
        selectedFrame: frame,
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
            select: { cancelRequestedAt: true, status: true, leaseToken: true },
          });
          if (
            !current ||
            current.cancelRequestedAt !== null ||
            current.status !== "RUNNING" ||
            current.leaseToken !== leaseToken ||
            controller.signal.aborted
          )
            throw canceled();
          for (const { result, artifact } of artifactByKind) {
            const body = result.kind === "MANIFEST" ? manifestBytes : artifact.body;
            await tx.asset.create({
              data: {
                id: result.id,
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
                id: result.id,
                workspaceId: context.workspaceId,
                renderJobId: jobId,
                kind: result.kind,
                assetId: result.id,
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
                assetId: result.id,
                assetVersion: 1,
                usedByType: "render_artifact",
                usedById: result.id,
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
          const published = await tx.renderJob.updateMany({
            where: {
              id: jobId,
              leaseToken,
              status: "RUNNING",
              cancelRequestedAt: null,
            },
            data: {
              status: "SUCCEEDED",
              errorCode: null,
              errorMessage: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          if (published.count !== 1) throw canceled();
        });
        committed = true;
        return this.present(context, jobId);
      } finally {
        if (!committed)
          await Promise.all(
            outputKeys.map((objectKey) =>
              this.storage
                .deleteObject({ workspaceId: context.workspaceId, objectKey })
                .catch(() => undefined),
            ),
          );
      }
    } catch (error) {
      const persisted = await this.db.renderJob.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
        select: { cancelRequestedAt: true, status: true },
      });
      const cancellationObserved =
        isCancellation(error, controller.signal) ||
        (persisted !== null &&
          persisted !== undefined &&
          (persisted.cancelRequestedAt !== null || persisted.status === "CANCELED"));
      if (cancellationObserved) {
        // Cancellation is terminal even when the canceling process is not the
        // executor. Preserve it across transient and permanent renderer errors.
        const terminalized = await this.db.renderJob.updateMany({
          where: {
            id: jobId,
            OR: [{ cancelRequestedAt: { not: null } }, { status: "CANCELED" }],
          },
          data: {
            status: "CANCELED",
            errorCode: "CANCELED",
            errorMessage: "Render was canceled",
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (terminalized.count === 0) return this.present(context, jobId);
        throw new ConflictException("Render was canceled");
      }
      const terminal = isPermanent(error);
      const retryAllowed = !terminal && claimed.attempt < claimed.maxRetries;
      // attempt is the 1-based execution ordinal for a scheduled claim. The
      // initial in-request execution is attempt zero, so the first retry uses
      // the base delay and each later retry doubles it.
      const delayMs = renderRetryDelayMs(claimed.attempt, claimed.retryBackoffMs);
      const terminalized = await this.db.renderJob.updateMany({
        where: { id: jobId, leaseToken, cancelRequestedAt: null },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          ...(retryAllowed ? { nextAttemptAt: new Date(this.now().getTime() + delayMs) } : {}),
          status: terminal || !retryAllowed ? "FAILED_FINAL" : "FAILED_RETRYABLE",
          errorCode: !retryAllowed && !terminal ? "RETRY_EXHAUSTED" : errorCode(error),
          errorMessage: safeMessage(error),
        },
      });
      if (terminalized.count === 0) return this.present(context, jobId);
      throw terminal ? new ConflictException(safeMessage(error), { cause: error }) : toHttp(error);
    } finally {
      clearInterval(heartbeat);
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
    if (
      pkg.scenes.length !== input.scenes.length ||
      [...pkg.scenes]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((scene) => scene.sceneId)
        .join("\0") !== input.scenes.map((scene) => scene.sceneId).join("\0")
    )
      throw new ConflictException("Composition must exactly preserve the active M09 scene order");
    const pinnedAssets = new Map<string, Awaited<ReturnType<AssetService["getReference"]>>>();
    for (const asset of [
      ...input.scenes.map((scene) => ({ assetId: scene.assetId, version: scene.assetVersion })),
      ...input.audio.map((audio) => ({ assetId: audio.assetId, version: audio.assetVersion })),
    ]) {
      const key = `${asset.assetId}:${asset.version}`;
      const existing = pinnedAssets.get(key);
      if (existing) continue;
      const reference = await this.assets.getReference(context, asset);
      if (
        reference.assetId !== asset.assetId ||
        reference.version !== asset.version ||
        !reference.licenseType ||
        !reference.rightsHolder ||
        reference.byteSize <= 0 ||
        !/^[0-9a-f]{64}$/.test(reference.checksumSha256)
      )
        throw new ConflictException(
          "Pinned input must be a published, licensed, checksummed asset",
        );
      pinnedAssets.set(key, reference);
    }
    for (const frame of input.coverFrames) {
      let start = 0;
      let coverScene: (typeof input.scenes)[number] | undefined;
      for (const [index, scene] of input.scenes.entries()) {
        const end = start + scene.durationMs;
        if (frame.timestampMs >= start && frame.timestampMs < end) {
          coverScene = scene;
          break;
        }
        start = end - (index < input.scenes.length - 1 ? input.profile.transitionDurationMs : 0);
      }
      if (
        !coverScene ||
        coverScene.assetId !== frame.assetId ||
        coverScene.assetVersion !== frame.assetVersion
      )
        throw new ConflictException("Cover must reference the M09 scene visible at its timestamp");
    }
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
  private async present(context: WorkspaceContext, id: string): Promise<RenderJobView> {
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { artifacts: { orderBy: { createdAt: "asc" } } },
    });
    if (!job) throw new NotFoundException("Render job not found");
    const expired = job.artifacts.some(
      (artifact) => artifact.retainedUntil !== null && artifact.retainedUntil <= this.now(),
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
  private async require(
    context: WorkspaceContext,
    id: string,
  ): Promise<{
    id: string;
    status: string;
    sceneMediaJobId: string;
    inputFingerprint: string;
    idempotencyKey: string;
    retentionDays: number;
    attempt: number;
    maxRetries: number;
    retryBackoffMs: number;
    nextAttemptAt: Date;
    leaseExpiresAt: Date | null;
    input: Prisma.JsonValue;
  }> {
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: {
        id: true,
        status: true,
        sceneMediaJobId: true,
        inputFingerprint: true,
        idempotencyKey: true,
        retentionDays: true,
        nextAttemptAt: true,
        leaseExpiresAt: true,
        maxRetries: true,
        retryBackoffMs: true,
        attempt: true,
        input: true,
      },
    });
    if (!job) throw new NotFoundException("Render job not found");
    return job;
  }
  private async existingId(
    workspaceId: string,
    idempotencyKey: string,
    inputFingerprint: string,
    retentionDays: number,
    parentId: string | null,
  ): Promise<string> {
    const existing = await this.db.renderJob.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      select: { id: true, inputFingerprint: true, retentionDays: true, parentJobId: true },
    });
    if (!existing) throw new ConflictException("Idempotent render could not be retrieved");
    if (
      existing.inputFingerprint !== inputFingerprint ||
      existing.retentionDays !== retentionDays ||
      existing.parentJobId !== parentId
    )
      throw new ConflictException(
        "The same idempotency key requires identical render input and retention for the same workflow",
      );
    return existing.id;
  }
  private editor(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }
}
function isPermanent(error: unknown): boolean {
  return error instanceof BadRequestException || error instanceof MediaValidationError;
}

function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
function canceled(): Error {
  return Object.assign(new Error("Render canceled"), { name: "AbortError" });
}
function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
function errorCode(error: unknown): string {
  if (error instanceof MediaValidationError) return error.errorCode;
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

type ClaimedRender = Readonly<{
  id: string;
  workspaceId: string;
  createdByUserId: string;
  leaseToken: string;
  attempt: number;
  maxRetries: number;
  retryBackoffMs: number;
  retentionDays: number;
  input: RenderCompositionInput;
}>;
