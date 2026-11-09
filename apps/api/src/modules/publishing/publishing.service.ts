import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DisclosureDecisionSchema,
  PostPublishedV1Schema,
  PublishFailedV1Schema,
  PublishedPostRecordSchema,
  YouTubeDestinationMetadataSchema,
  type YouTubeDestinationMetadata,
} from "@reelforge/contracts";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@reelforge/database";
import {
  SocialProviderError,
  type AuthenticatedPlatformClient,
  type YouTubeUploadProgress,
} from "@reelforge/social-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import { CompositionService } from "../composition/composition.service.js";
import type { RenderManifest } from "../composition/composition.manifest.js";
import { QualityService } from "../quality/quality.service.js";
import { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import {
  CalendarRangeSchema,
  CreateScheduledPostSchema,
  UpdateScheduledPostSchema,
} from "./publishing.validation.js";
import {
  PUBLISHING_BUDGET_PORT,
  PUBLISHING_SCHEDULE_PORT,
  type PublishingBudgetPort,
  type PublishingPolicyContext,
  type PublishingSchedulePort,
} from "./publishing.ports.js";
import {
  PublishingSessionVault,
  type EncryptedPublishingSession,
} from "./publishing-session-vault.js";
import type {
  PublishingDestinationView,
  PublishingPreflightGate,
  PublishingPreflightView,
  PublishedPostExport,
  ScheduledPostView,
} from "./publishing.types.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const uploadChunkSize = 8 * 1024 * 1024;
const latestAttemptInclude = {
  orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
  take: 1,
} satisfies Prisma.PublishAttemptFindManyArgs;
const postInclude = {
  destinations: {
    include: { publishJob: { include: { attempts: latestAttemptInclude } } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.ScheduledPostInclude;
const destinationInclude = {
  scheduledPost: true,
  publishJob: { include: { attempts: latestAttemptInclude } },
} satisfies Prisma.PublishingDestinationInclude;
type ScheduledPostRecord = Prisma.ScheduledPostGetPayload<{ include: typeof postInclude }>;
type DestinationRecord = Prisma.PublishingDestinationGetPayload<{
  include: typeof destinationInclude;
}>;
type PresentedDestinationRecord = Prisma.PublishingDestinationGetPayload<{
  include: { publishJob: { include: { attempts: typeof latestAttemptInclude } } };
}>;
type LatestAttempt =
  NonNullable<PresentedDestinationRecord["publishJob"]>["attempts"][number] | null;
type PublishAttemptRecord = Prisma.PublishAttemptGetPayload<object>;
type RenderRecord = Prisma.RenderJobGetPayload<{
  include: { sceneMediaJob: true; artifacts: true };
}>;

@Injectable()
export class PublishingService {
  public constructor(
    @Inject("DATABASE") private readonly db: PrismaClient,
    private readonly composition: CompositionService,
    private readonly quality: QualityService,
    private readonly socialAccounts: SocialAccountsService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(PUBLISHING_SCHEDULE_PORT) private readonly schedulePolicy: PublishingSchedulePort,
    @Inject(PUBLISHING_BUDGET_PORT) private readonly budgetPolicy: PublishingBudgetPort,
    private readonly sessionVault: PublishingSessionVault,
  ) {}

  public async createScheduledPost(
    context: WorkspaceContext,
    body: unknown,
  ): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const parsed = CreateScheduledPostSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const request = parsed.data;
    const channel = await this.db.channel.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: request.channelId } },
      select: { id: true, status: true },
    });
    if (!channel || channel.status === "ARCHIVED") throw new NotFoundException("Channel not found");
    const render = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: request.renderJobId } },
      include: { sceneMediaJob: true, artifacts: true },
    });
    if (!render || render.sceneMediaJob.channelId !== request.channelId)
      throw new NotFoundException("Render job not found for this channel");
    const review = await this.db.qualityReviewRun.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: request.qualityReviewRunId },
      },
      select: { renderJobId: true },
    });
    if (!review || review.renderJobId !== request.renderJobId)
      throw new NotFoundException("Quality review not found for this render");
    for (const destination of request.destinations) {
      const account = await this.db.socialAccount.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: context.workspaceId,
            id: destination.socialAccountId,
          },
        },
        select: { channelId: true, platform: true },
      });
      if (
        !account ||
        account.channelId !== request.channelId ||
        account.platform !== destination.platform
      )
        throw new BadRequestException(
          "Each destination must be a connected account on this channel",
        );
    }

    const scheduledAt = request.scheduledAt === null ? null : new Date(request.scheduledAt);
    const disclosure = DisclosureDecisionSchema.parse(request.disclosure);
    const post = await this.db.$transaction(async (tx) => {
      const created = await tx.scheduledPost.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: request.channelId,
          renderJobId: request.renderJobId,
          qualityReviewRunId: request.qualityReviewRunId,
          scheduledAt,
          status: scheduledAt === null ? "DRAFT" : "SCHEDULED",
          disclosureDecision: disclosure.decision,
          disclosureText: disclosure.decision === "DISCLOSE" ? disclosure.disclosureText : null,
          disclosureReason: disclosure.reason,
          createdByUserId: context.userId,
        },
      });
      for (const item of request.destinations) {
        const idempotencyKey = randomUUID();
        const destination = await tx.publishingDestination.create({
          data: {
            workspaceId: context.workspaceId,
            scheduledPostId: created.id,
            socialAccountId: item.socialAccountId,
            platform: item.platform,
            metadata: item.metadata as Prisma.InputJsonValue,
            status: scheduledAt === null ? "DRAFT" : "SCHEDULED",
            idempotencyKey,
          },
        });
        await tx.publishJob.create({
          data: {
            workspaceId: context.workspaceId,
            destinationId: destination.id,
            status: destination.status,
            idempotencyKey,
          },
        });
      }
      return created;
    });
    return this.getScheduledPost(context, post.id);
  }

  public async listCalendar(
    context: WorkspaceContext,
    from: string,
    to: string,
  ): Promise<ScheduledPostView[]> {
    const range = this.parseCalendarRange(from, to);
    const posts = await this.db.scheduledPost.findMany({
      where: {
        workspaceId: context.workspaceId,
        scheduledAt: { gte: range.from, lt: range.to },
        status: { not: "CANCELED" },
      },
      include: postInclude,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    });
    return posts.map((post) => this.presentPost(post));
  }

  public async getScheduledPost(
    context: WorkspaceContext,
    scheduledPostId: string,
  ): Promise<ScheduledPostView> {
    const post = await this.db.scheduledPost.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: scheduledPostId } },
      include: postInclude,
    });
    if (!post) throw new NotFoundException("Scheduled post not found");
    return this.presentPost(post);
  }

  public async updateScheduledPost(
    context: WorkspaceContext,
    scheduledPostId: string,
    body: unknown,
  ): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const parsed = UpdateScheduledPostSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const post = await this.requirePost(context.workspaceId, scheduledPostId);
    await this.requireEditableBeforePublish(post);
    const scheduledAt =
      parsed.data.scheduledAt === undefined
        ? post.scheduledAt
        : parsed.data.scheduledAt === null
          ? null
          : new Date(parsed.data.scheduledAt);
    const disclosure =
      parsed.data.disclosure === undefined
        ? null
        : DisclosureDecisionSchema.parse(parsed.data.disclosure);
    await this.db.$transaction(async (tx) => {
      await tx.scheduledPost.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: scheduledPostId } },
        data: {
          scheduledAt,
          status: scheduledAt === null ? "DRAFT" : "SCHEDULED",
          ...(disclosure === null
            ? {}
            : {
                disclosureDecision: disclosure.decision,
                disclosureText:
                  disclosure.decision === "DISCLOSE" ? disclosure.disclosureText : null,
                disclosureReason: disclosure.reason,
              }),
        },
      });
      await tx.publishingDestination.updateMany({
        where: { workspaceId: context.workspaceId, scheduledPostId },
        data: { status: scheduledAt === null ? "DRAFT" : "SCHEDULED" },
      });
      await tx.publishJob.updateMany({
        where: { workspaceId: context.workspaceId, destination: { scheduledPostId } },
        data: { status: scheduledAt === null ? "DRAFT" : "SCHEDULED" },
      });
    });
    return this.getScheduledPost(context, scheduledPostId);
  }

  public async cancelScheduledPost(
    context: WorkspaceContext,
    scheduledPostId: string,
  ): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const post = await this.requirePost(context.workspaceId, scheduledPostId);
    await this.requireEditableBeforePublish(post);
    await this.db.$transaction(async (tx) => {
      await tx.scheduledPost.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: scheduledPostId } },
        data: { status: "CANCELED" },
      });
      await tx.publishingDestination.updateMany({
        where: { workspaceId: context.workspaceId, scheduledPostId },
        data: { status: "CANCELED" },
      });
      await tx.publishJob.updateMany({
        where: { workspaceId: context.workspaceId, destination: { scheduledPostId } },
        data: { status: "CANCELED", canceledAt: new Date() },
      });
    });
    return this.getScheduledPost(context, scheduledPostId);
  }

  public async preflight(
    context: WorkspaceContext,
    destinationId: string,
  ): Promise<PublishingPreflightView> {
    const destination = await this.requireDestination(context.workspaceId, destinationId);
    const post = destination.scheduledPost;
    const gates: PublishingPreflightGate[] = [];
    let hardGates:
      readonly Awaited<ReturnType<QualityService["assertPublishable"]>>[number][] | null = null;
    let approvalPassed = false;
    let hardGatePass = false;
    let approvalEvidence = "A current M11 approval is required.";
    let hardGateEvidence = "All current M11 hard gates must pass.";
    const review = await this.quality
      .get(context, post.qualityReviewRunId)
      .catch((error: unknown) => {
        if (isExpectedPreflightError(error)) return null;
        throw error;
      });
    if (review !== null) {
      approvalPassed = review.status === "APPROVED" || review.status === "AUTO_APPROVED";
      const selectedHardGates = review.gateSummary;
      hardGates = selectedHardGates;
      hardGatePass = selectedHardGates.length > 0 && selectedHardGates.every((item) => item.passed);
      approvalEvidence = approvalPassed
        ? `Selected M11 review status is ${review.status}.`
        : `Selected M11 review status is ${review.status}; approval is required.`;
      hardGateEvidence = hardGatePass
        ? "The selected M11 review reports every hard gate passing."
        : "The selected M11 review has missing or failed hard gates.";
      try {
        hardGates = await this.quality.assertPublishable(
          context,
          post.renderJobId,
          post.qualityReviewRunId,
        );
        approvalPassed = true;
        hardGatePass = hardGates.length > 0 && hardGates.every((item) => item.passed);
        approvalEvidence = "M11 approval is current and belongs to the latest review.";
        hardGateEvidence = hardGatePass
          ? "M11 revalidated current rights, provenance, policy, and hard gates."
          : "M11 publish-time hard gates are incomplete or failed.";
      } catch (error) {
        if (!isExpectedPreflightError(error)) throw error;
        approvalPassed = false;
        hardGatePass = false;
        approvalEvidence = errorMessage(error);
        hardGateEvidence = errorMessage(error);
      }
    } else {
      approvalEvidence = "The selected M11 review is unavailable in this workspace.";
      hardGateEvidence = approvalEvidence;
    }
    gates.push(gate("APPROVAL", approvalPassed, approvalEvidence));
    gates.push(gate("HARD_GATES", hardGatePass, hardGateEvidence));

    let render: RenderRecord | null = null;
    let manifest: RenderManifest | null = null;
    let artifact: RenderRecord["artifacts"][number] | null = null;
    let mediaEvidence = "A successful, retained render with a verified video artifact is required.";
    try {
      render = await this.db.renderJob.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: post.renderJobId } },
        include: { sceneMediaJob: true, artifacts: true },
      });
      if (
        render === null ||
        render.status !== "SUCCEEDED" ||
        render.expiredAt !== null ||
        render.sceneMediaJob.channelId !== post.channelId
      )
        throw new ConflictException(
          "The selected render is not a successful active channel render",
        );
      manifest = await this.composition.getManifest(context, post.renderJobId);
      artifact = render.artifacts.find((item) => item.kind === "VIDEO") ?? null;
      if (
        artifact === null ||
        manifest.video.byteSize !== artifact.byteSize ||
        manifest.video.checksumSha256 !== artifact.checksumSha256 ||
        manifest.video.objectKey !== artifact.objectKey
      )
        throw new ConflictException("The rendered video does not match its verified manifest");
      mediaEvidence = "M10 verified the successful render, manifest, media size, and checksum.";
    } catch (error) {
      if (!isExpectedPreflightError(error)) throw error;
      mediaEvidence = errorMessage(error);
    }
    gates.push(gate("MEDIA", manifest !== null && artifact !== null, mediaEvidence));

    const metadata = this.parseDestinationMetadata(destination);
    const metadataPassed = metadata !== null;
    gates.push(
      gate(
        "METADATA",
        metadataPassed,
        metadataPassed
          ? "Destination metadata passed its strict platform schema."
          : "Destination metadata is invalid or unsupported by the configured connector.",
      ),
    );
    const disclosurePassed =
      post.disclosureDecision === "NOT_REQUIRED"
        ? post.disclosureReason.trim().length > 0
        : post.disclosureText !== null &&
          metadata !== null &&
          "description" in metadata &&
          metadata.description.includes(post.disclosureText);
    gates.push(
      gate(
        "DISCLOSURE",
        disclosurePassed,
        disclosurePassed
          ? "An explicit disclosure decision is stored on the post and applied to destination metadata."
          : "An explicit disclosure decision and required destination disclosure text are required.",
      ),
    );

    let client: AuthenticatedPlatformClient | null = null;
    let accountEvidence = "A connected account on this channel is required.";
    try {
      client = await this.socialAccounts.authenticatedClient(context, destination.socialAccountId);
      if (
        client.account.channelId !== post.channelId ||
        client.account.platform !== destination.platform ||
        client.account.health !== "HEALTHY"
      )
        throw new ConflictException("The destination account is not healthy for this channel");
      accountEvidence = "M12 returned a connected, healthy account for this channel and platform.";
    } catch (error) {
      if (!isExpectedPreflightError(error)) throw error;
      accountEvidence = errorMessage(error);
    }
    gates.push(
      gate("ACCOUNT", client !== null && accountEvidence.startsWith("M12"), accountEvidence),
    );
    const scopesPassed =
      client !== null &&
      client.account.permissions.some(
        (permission) =>
          permission.permission === "https://www.googleapis.com/auth/youtube.upload" &&
          permission.status === "GRANTED",
      );
    const capabilitiesPassed =
      client !== null &&
      ["VIDEO_UPLOAD", "RESUMABLE_UPLOAD"].every((required) =>
        client.account.capabilities.some(
          (capability) =>
            capability.capability === required &&
            capability.enabled &&
            capability.details?.["executionImplemented"] === true,
        ),
      );
    const scopePass = destination.platform === "YOUTUBE" && scopesPassed && capabilitiesPassed;
    gates.push(
      gate(
        "SCOPE",
        scopePass,
        scopePass
          ? "M12 confirms the YouTube upload scope and executable resumable-upload capabilities."
          : destination.platform === "INSTAGRAM"
            ? "Instagram publishing is not configured and remains fail-closed."
            : "M12 does not confirm the YouTube upload scope and executable capabilities.",
      ),
    );

    const policyContext = this.policyContext(destination);
    const scheduleCheck = await this.schedulePolicy.check(policyContext);
    gates.push(gate("SCHEDULE", scheduleCheck.allowed, scheduleCheck.reason));
    const budgetCheck = await this.budgetPolicy.check(policyContext);
    gates.push(gate("BUDGET", budgetCheck.allowed, budgetCheck.reason));
    gates.push(
      gate(
        "RECONCILIATION_STORAGE",
        this.sessionVault.isConfigured(),
        this.sessionVault.isConfigured()
          ? "Resumable upload sessions can be encrypted before persistence."
          : "PUBLISH_SESSION_ENCRYPTION_KEY is not configured; resumable sessions cannot be persisted safely.",
      ),
    );
    return {
      scheduledPostId: post.id,
      destinationId: destination.id,
      canPublish: gates.every((item) => item.passed),
      gates,
      hardGates,
    };
  }

  public async publishNow(
    context: WorkspaceContext,
    destinationId: string,
  ): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const destination = await this.requireDestination(context.workspaceId, destinationId);
    if (destination.status === "PUBLISHED")
      return this.getScheduledPost(context, destination.scheduledPostId);
    if (
      destination.status === "REMOTE_PROCESSING" ||
      destination.status === "RECONCILIATION_REQUIRED"
    )
      throw new ConflictException("Reconcile the existing upload before another publish attempt");
    if (destination.status === "FAILED_RETRYABLE") return this.retry(context, destinationId);
    const preflight = await this.preflight(context, destinationId);
    this.requirePassingPreflight(preflight);
    return this.startNewUpload(context, destination);
  }

  public async retry(context: WorkspaceContext, destinationId: string): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const current = await this.requireDestination(context.workspaceId, destinationId);
    let lastAttempt = current.publishJob?.attempts[0] ?? null;
    if (lastAttempt?.sessionCiphertext !== null && lastAttempt?.sessionCiphertext !== undefined) {
      await this.reconcile(context, destinationId);
      const reconciled = await this.requireDestination(context.workspaceId, destinationId);
      if (reconciled.status === "PUBLISHED" || reconciled.status === "REMOTE_PROCESSING")
        return this.getScheduledPost(context, reconciled.scheduledPostId);
      if (reconciled.status === "RECONCILIATION_REQUIRED")
        throw new ConflictException(
          "The upload outcome is still unknown; automatic retry is blocked",
        );
      lastAttempt = reconciled.publishJob?.attempts[0] ?? null;
    }
    const destination = await this.requireDestination(context.workspaceId, destinationId);
    if (destination.remotePostId !== null) {
      await this.reconcile(context, destinationId);
      return this.getScheduledPost(context, destination.scheduledPostId);
    }
    if (
      destination.status !== "FAILED_RETRYABLE" &&
      destination.status !== "DRAFT" &&
      destination.status !== "SCHEDULED"
    )
      throw new ConflictException("Only a retryable publish job can be retried");
    const preflight = await this.preflight(context, destinationId);
    this.requirePassingPreflight(preflight);
    if (lastAttempt?.sessionCiphertext) {
      return this.resumeUpload(context, destination, lastAttempt);
    }
    return this.startNewUpload(context, destination);
  }

  public async reconcile(
    context: WorkspaceContext,
    destinationId: string,
  ): Promise<ScheduledPostView> {
    this.requireEditor(context);
    const destination = await this.requireDestination(context.workspaceId, destinationId);
    const job = destination.publishJob;
    const attempt = job?.attempts[0] ?? null;
    if (!job || !attempt) throw new ConflictException("No upload attempt exists to reconcile");
    const metadata = this.youtubeMetadata(destination);
    try {
      const client = await this.socialAccounts.authenticatedClient(
        context,
        destination.socialAccountId,
      );
      if (attempt.remotePostId !== null) {
        const verified = await client.verifyUploadedVideo(attempt.remotePostId, metadata);
        await this.recordVerifiedVideo(
          context.workspaceId,
          destination,
          job.id,
          attempt.id,
          verified,
        );
      } else if (attempt.sessionCiphertext !== null) {
        const sessionUri = this.decryptSession(context.workspaceId, job.id, attempt);
        const progress = await client.checkVideoUpload(sessionUri, Number(attempt.totalBytes));
        if (progress.completed) {
          await this.db.publishAttempt.update({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: attempt.id } },
            data: { remotePostId: progress.videoId },
          });
          const verified = await client.verifyUploadedVideo(progress.videoId, metadata);
          await this.recordVerifiedVideo(
            context.workspaceId,
            destination,
            job.id,
            attempt.id,
            verified,
          );
        } else {
          await this.db.publishAttempt.update({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: attempt.id } },
            data: { confirmedBytes: BigInt(progress.nextByte), status: "FAILED_RETRYABLE" },
          });
          await this.setDestinationState(
            context.workspaceId,
            destination.id,
            job.id,
            "FAILED_RETRYABLE",
          );
        }
      } else {
        throw new ConflictException("No resumable session or remote ID is available to reconcile");
      }
    } catch (error) {
      if (!(error instanceof SocialProviderError) && !isExpectedPreflightError(error)) throw error;
      await this.markReconciliationRequired(
        context.workspaceId,
        destination,
        job.id,
        attempt.id,
        safeErrorCode(error),
        "The upload could not be reconciled; do not retry until its outcome is known.",
      );
    }
    return this.getScheduledPost(context, destination.scheduledPostId);
  }

  public async reschedule(
    context: WorkspaceContext,
    scheduledPostId: string,
    scheduledAt: string | null,
  ): Promise<ScheduledPostView> {
    return this.updateScheduledPost(context, scheduledPostId, { scheduledAt });
  }

  public async listPublishedRecords(
    context: WorkspaceContext,
    after: string | null = null,
    limit = 100,
    afterId: string | null = null,
  ): Promise<PublishedPostExport[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException("limit must be an integer between 1 and 100");
    const afterDate = after === null ? null : new Date(after);
    if (afterDate !== null && Number.isNaN(afterDate.getTime()))
      throw new BadRequestException("after must be a valid ISO timestamp");
    if ((afterDate === null) !== (afterId === null))
      throw new BadRequestException("after and afterId must be provided together");
    if (afterId !== null && !z.uuid().safeParse(afterId).success)
      throw new BadRequestException("afterId must be a valid UUID");
    const destinations = await this.db.publishingDestination.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: "PUBLISHED",
        remotePostId: { not: null },
        publishedAt: { not: null },
        ...(afterDate === null || afterId === null
          ? {}
          : {
              OR: [
                { publishedAt: { gt: afterDate } },
                { publishedAt: afterDate, id: { gt: afterId } },
              ],
            }),
      },
      include: { scheduledPost: true, publishJob: true, socialAccount: true },
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    return destinations.map((destination) =>
      PublishedPostRecordSchema.parse({
        workspaceId: destination.workspaceId,
        channelId: destination.scheduledPost.channelId,
        scheduledPostId: destination.scheduledPostId,
        destinationId: destination.id,
        publishJobId: destination.publishJob?.id,
        renderJobId: destination.scheduledPost.renderJobId,
        accountId: destination.socialAccountId,
        platform: destination.platform,
        platformPostId: destination.remotePostId,
        publishedAt: destination.publishedAt?.toISOString(),
      }),
    );
  }

  private async startNewUpload(
    context: WorkspaceContext,
    destination: DestinationRecord,
  ): Promise<ScheduledPostView> {
    if (destination.remotePostId !== null)
      throw new ConflictException(
        "A remote video already exists; reconcile it instead of uploading again",
      );
    const metadata = this.youtubeMetadata(destination);
    const { manifest, video } = await this.getVerifiedVideo(context, destination);
    const job = destination.publishJob;
    if (!job) throw new InternalServerErrorException("Publish job is missing");
    const reservation = await this.budgetPolicy.reserve(this.policyContext(destination));
    let attempt: Awaited<ReturnType<PublishingService["claimAttempt"]>> | null = null;
    let sessionCreated = false;
    try {
      attempt = await this.claimAttempt(context, destination, job.id, BigInt(video.length), null);
      const client = await this.socialAccounts.authenticatedClient(
        context,
        destination.socialAccountId,
      );
      const sessionUri = await client.startVideoUpload(
        metadata,
        video.length,
        manifest.video.mediaType,
      );
      const encrypted = this.sessionVault.encrypt(
        sessionUri,
        this.sessionContext(context.workspaceId, job.id, attempt.id),
      );
      await this.saveSessionWithRetry(
        context.workspaceId,
        job.id,
        attempt.id,
        encrypted,
        BigInt(video.length),
      );
      sessionCreated = true;
      await this.transferUpload(
        context,
        destination,
        job.id,
        attempt.id,
        client,
        metadata,
        sessionUri,
        video,
        0,
      );
    } catch (error) {
      if (attempt !== null) {
        if (sessionCreated) {
          await this.markReconciliationRequired(
            context.workspaceId,
            destination,
            job.id,
            attempt.id,
            safeErrorCode(error),
            "Upload started; reconcile the persisted session before retrying.",
          );
        } else {
          await this.markAttemptFailure(
            context.workspaceId,
            destination,
            job.id,
            attempt.id,
            error,
          );
          await this.budgetPolicy.release(reservation);
        }
      } else {
        await this.budgetPolicy.release(reservation);
      }
      throw error;
    }
    const result = await this.getScheduledPost(context, destination.scheduledPostId);
    const destinationStatus = result.destinations.find(
      (item) => item.id === destination.id,
    )?.status;
    if (destinationStatus === "PUBLISHED" || destinationStatus === "FAILED_FINAL")
      await this.budgetPolicy.settle(reservation);
    return result;
  }

  private async resumeUpload(
    context: WorkspaceContext,
    destination: DestinationRecord,
    previousAttempt: NonNullable<LatestAttempt>,
  ): Promise<ScheduledPostView> {
    const metadata = this.youtubeMetadata(destination);
    const { video } = await this.getVerifiedVideo(context, destination);
    const job = destination.publishJob;
    if (!job) throw new InternalServerErrorException("Publish job is missing");
    const oldSession = this.decryptSession(context.workspaceId, job.id, previousAttempt);
    const reservation = await this.budgetPolicy.reserve(this.policyContext(destination));
    let attempt: Awaited<ReturnType<PublishingService["claimAttempt"]>> | null = null;
    try {
      attempt = await this.claimAttempt(
        context,
        destination,
        job.id,
        BigInt(video.length),
        oldSession,
      );
      const sessionUri = oldSession;
      const client = await this.socialAccounts.authenticatedClient(
        context,
        destination.socialAccountId,
      );
      await this.transferUpload(
        context,
        destination,
        job.id,
        attempt.id,
        client,
        metadata,
        sessionUri,
        video,
        Number(previousAttempt.confirmedBytes),
      );
    } catch (error) {
      if (attempt !== null) {
        await this.markReconciliationRequired(
          context.workspaceId,
          destination,
          job.id,
          attempt.id,
          safeErrorCode(error),
          "Upload resumed; reconcile the persisted session before another retry.",
        );
      } else {
        await this.budgetPolicy.release(reservation);
      }
      throw error;
    }
    const result = await this.getScheduledPost(context, destination.scheduledPostId);
    const destinationStatus = result.destinations.find(
      (item) => item.id === destination.id,
    )?.status;
    if (destinationStatus === "PUBLISHED" || destinationStatus === "FAILED_FINAL")
      await this.budgetPolicy.settle(reservation);
    return result;
  }

  private async transferUpload(
    context: WorkspaceContext,
    destination: DestinationRecord,
    jobId: string,
    attemptId: string,
    client: AuthenticatedPlatformClient,
    metadata: YouTubeDestinationMetadata,
    sessionUri: string,
    video: Buffer,
    knownOffset: number,
  ): Promise<void> {
    let progress: YouTubeUploadProgress;
    try {
      progress = await client.checkVideoUpload(sessionUri, video.length);
    } catch (error) {
      await this.markReconciliationRequired(
        context.workspaceId,
        destination,
        jobId,
        attemptId,
        safeErrorCode(error),
        "The upload status check failed; no upload retry was attempted.",
      );
      throw error;
    }
    if (progress.completed) {
      await this.verifyAndRecord(
        context,
        destination,
        jobId,
        attemptId,
        client,
        metadata,
        progress.videoId,
      );
      return;
    }
    let offset = progress.nextByte;
    if (offset < 0 || offset > video.length || (knownOffset > offset && offset !== 0)) {
      await this.markReconciliationRequired(
        context.workspaceId,
        destination,
        jobId,
        attemptId,
        "INVALID_UPLOAD_OFFSET",
        "YouTube reported an invalid resumable upload offset.",
      );
      throw new ConflictException("The YouTube resumable upload offset is invalid");
    }
    let noProgressCount = 0;
    while (offset < video.length) {
      const end = Math.min(offset + uploadChunkSize, video.length);
      try {
        progress = await client.uploadVideoChunk(
          sessionUri,
          offset,
          video.length,
          video.subarray(offset, end),
        );
      } catch {
        try {
          progress = await client.checkVideoUpload(sessionUri, video.length);
        } catch (reconcileError) {
          await this.markReconciliationRequired(
            context.workspaceId,
            destination,
            jobId,
            attemptId,
            safeErrorCode(reconcileError),
            "A chunk outcome is unknown and the session could not be reconciled.",
          );
          throw reconcileError;
        }
      }
      if (progress.completed) {
        await this.verifyAndRecord(
          context,
          destination,
          jobId,
          attemptId,
          client,
          metadata,
          progress.videoId,
        );
        return;
      }
      if (progress.nextByte < 0 || progress.nextByte > video.length || progress.nextByte < offset) {
        await this.markReconciliationRequired(
          context.workspaceId,
          destination,
          jobId,
          attemptId,
          "INVALID_UPLOAD_OFFSET",
          "YouTube reported an invalid resumable upload offset.",
        );
        throw new ConflictException("The resumable upload made no progress");
      }
      if (progress.nextByte === offset) {
        noProgressCount++;
        if (noProgressCount >= 3) {
          await this.markReconciliationRequired(
            context.workspaceId,
            destination,
            jobId,
            attemptId,
            "UPLOAD_NO_PROGRESS",
            "The resumable upload made no progress after three reconciled attempts.",
          );
          return;
        }
      } else {
        noProgressCount = 0;
        offset = progress.nextByte;
        await this.db.publishAttempt.update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: attemptId } },
          data: { confirmedBytes: BigInt(offset), status: "UPLOADING" },
        });
      }
    }
    await this.markReconciliationRequired(
      context.workspaceId,
      destination,
      jobId,
      attemptId,
      "UPLOAD_COMPLETION_UNCONFIRMED",
      "All bytes were sent but YouTube did not confirm the video; reconcile before retrying.",
    );
    throw new ConflictException("The upload completion is unconfirmed; reconcile before retrying");
  }

  private async verifyAndRecord(
    context: WorkspaceContext,
    destination: DestinationRecord,
    jobId: string,
    attemptId: string,
    client: AuthenticatedPlatformClient,
    metadata: YouTubeDestinationMetadata,
    remoteVideoId: string,
  ): Promise<void> {
    await this.db.publishAttempt.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: attemptId } },
      data: { remotePostId: remoteVideoId, status: "REMOTE_PROCESSING" },
    });
    const verified = await client.verifyUploadedVideo(remoteVideoId, metadata);
    await this.recordVerifiedVideo(context.workspaceId, destination, jobId, attemptId, verified);
  }

  private async recordVerifiedVideo(
    workspaceId: string,
    destination: DestinationRecord,
    jobId: string,
    attemptId: string,
    verified: Awaited<ReturnType<AuthenticatedPlatformClient["verifyUploadedVideo"]>>,
  ): Promise<void> {
    const rejected =
      verified.uploadStatus === "failed" ||
      verified.uploadStatus === "rejected" ||
      verified.uploadStatus === "deleted" ||
      verified.processingStatus === "failed" ||
      verified.processingStatus === "terminated";
    const published =
      !rejected &&
      (verified.uploadStatus === "processed" || verified.processingStatus === "succeeded");
    const status = rejected ? "FAILED_FINAL" : published ? "PUBLISHED" : "REMOTE_PROCESSING";
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      const currentDestination = await tx.publishingDestination.findUnique({
        where: { workspaceId_id: { workspaceId, id: destination.id } },
        select: { status: true, publishedAt: true },
      });
      await tx.publishAttempt.update({
        where: { workspaceId_id: { workspaceId, id: attemptId } },
        data: {
          status: rejected ? "FAILED_FINAL" : published ? "SUCCEEDED" : "REMOTE_PROCESSING",
          remotePostId: verified.videoId,
          finishedAt: published || rejected ? now : null,
          errorCode: rejected ? "YOUTUBE_PROCESSING_FAILED" : null,
          errorMessage: rejected
            ? "YouTube rejected or failed to process the uploaded video."
            : null,
        },
      });
      await tx.publishingDestination.update({
        where: { workspaceId_id: { workspaceId, id: destination.id } },
        data: {
          status,
          remotePostId: verified.videoId,
          publishedAt: published ? (currentDestination?.publishedAt ?? now) : null,
          lastErrorCode: rejected ? "YOUTUBE_PROCESSING_FAILED" : null,
          lastErrorMessage: rejected
            ? "YouTube rejected or failed to process the uploaded video."
            : null,
        },
      });
      await tx.publishJob.update({
        where: { workspaceId_id: { workspaceId, id: jobId } },
        data: { status },
      });
      await this.updateParentStatus(tx, workspaceId, destination.scheduledPostId);
      if (published && currentDestination?.status !== "PUBLISHED") {
        const event = PostPublishedV1Schema.parse({
          eventId: randomUUID(),
          eventType: "PostPublished",
          eventVersion: 1,
          occurredAt: now.toISOString(),
          workspaceId,
          channelId: destination.scheduledPost.channelId,
          correlationId: randomUUID(),
          idempotencyKey: `post-published:${destination.id}`,
          aggregateType: "publishing_destination",
          aggregateId: destination.id,
          payload: {
            postId: destination.scheduledPostId,
            platform: destination.platform,
            platformPostId: verified.videoId,
          },
        });
        await tx.outboxEvent.upsert({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId,
              idempotencyKey: event.idempotencyKey,
            },
          },
          create: {
            id: event.eventId,
            workspaceId,
            eventType: event.eventType,
            eventVersion: event.eventVersion,
            occurredAt: now,
            channelId: destination.scheduledPost.channelId,
            correlationId: event.correlationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
          },
          update: {},
        });
      } else if (rejected && currentDestination?.status !== "FAILED_FINAL") {
        const event = PublishFailedV1Schema.parse({
          eventId: randomUUID(),
          eventType: "PublishFailed",
          eventVersion: 1,
          occurredAt: now.toISOString(),
          workspaceId,
          channelId: destination.scheduledPost.channelId,
          correlationId: randomUUID(),
          idempotencyKey: `publish-failed:${destination.id}`,
          aggregateType: "publishing_destination",
          aggregateId: destination.id,
          payload: {
            postId: destination.scheduledPostId,
            failureCode: "YOUTUBE_PROCESSING_FAILED",
            retryable: false,
          },
        });
        await tx.outboxEvent.upsert({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId,
              idempotencyKey: event.idempotencyKey,
            },
          },
          create: {
            id: event.eventId,
            workspaceId,
            eventType: event.eventType,
            eventVersion: event.eventVersion,
            occurredAt: now,
            channelId: destination.scheduledPost.channelId,
            correlationId: event.correlationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
          },
          update: {},
        });
      }
    });
  }

  private async claimAttempt(
    context: WorkspaceContext,
    destination: DestinationRecord,
    jobId: string,
    totalBytes: bigint,
    sessionUri: string | null,
  ): Promise<PublishAttemptRecord> {
    return this.db.$transaction(async (tx) => {
      const job = await tx.publishJob.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
        select: { status: true, retryCount: true },
      });
      if (!job || !["DRAFT", "SCHEDULED", "FAILED_RETRYABLE"].includes(job.status))
        throw new ConflictException("Publish job is not ready for a manual upload attempt");
      const claim = await tx.publishJob.updateMany({
        where: {
          workspaceId_id: { workspaceId: context.workspaceId, id: jobId },
          status: job.status,
        },
        data: { status: "UPLOADING", retryCount: { increment: 1 }, nextAttemptAt: null },
      });
      if (claim.count !== 1)
        throw new ConflictException("Another publish attempt claimed this destination");
      const count = await tx.publishAttempt.count({
        where: { workspaceId: context.workspaceId, publishJobId: jobId },
      });
      const attemptId = randomUUID();
      const attemptKey = `${destination.idempotencyKey}:attempt:${count + 1}`;
      const encryptedSession =
        sessionUri === null
          ? null
          : this.sessionVault.encrypt(
              sessionUri,
              this.sessionContext(context.workspaceId, jobId, attemptId),
            );
      const attempt = await tx.publishAttempt.create({
        data: {
          id: attemptId,
          workspaceId: context.workspaceId,
          publishJobId: jobId,
          attemptNumber: count + 1,
          idempotencyKey: attemptKey,
          status: "STARTED",
          totalBytes,
          ...(encryptedSession === null
            ? {}
            : {
                sessionCiphertext: encryptedSession.ciphertext,
                sessionNonce: encryptedSession.nonce,
                sessionTag: encryptedSession.tag,
                sessionKeyVersion: encryptedSession.keyVersion,
              }),
        },
      });
      await tx.publishingDestination.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: destination.id } },
        data: { status: "UPLOADING", lastErrorCode: null, lastErrorMessage: null },
      });
      await tx.scheduledPost.update({
        where: {
          workspaceId_id: {
            workspaceId: context.workspaceId,
            id: destination.scheduledPostId,
          },
        },
        data: {
          status: "UPLOADING",
          manuallyAuthorizedAt: new Date(),
          manuallyAuthorizedByUserId: context.userId,
        },
      });
      return attempt;
    });
  }

  private async saveSession(
    workspaceId: string,
    attemptId: string,
    encrypted: EncryptedPublishingSession,
    totalBytes: bigint,
  ): Promise<void> {
    await this.db.publishAttempt.update({
      where: { workspaceId_id: { workspaceId, id: attemptId } },
      data: {
        status: "UPLOADING",
        totalBytes,
        sessionCiphertext: encrypted.ciphertext,
        sessionNonce: encrypted.nonce,
        sessionTag: encrypted.tag,
        sessionKeyVersion: encrypted.keyVersion,
      },
    });
  }

  private async saveSessionWithRetry(
    workspaceId: string,
    jobId: string,
    attemptId: string,
    encrypted: EncryptedPublishingSession,
    totalBytes: bigint,
  ): Promise<void> {
    let lastError: unknown;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await this.saveSession(workspaceId, attemptId, encrypted, totalBytes);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Could not persist resumable upload session for job ${jobId} after three attempts`,
      { cause: lastError },
    );
  }

  private async markAttemptFailure(
    workspaceId: string,
    destination: DestinationRecord,
    jobId: string,
    attemptId: string,
    error: unknown,
  ): Promise<void> {
    const retryable =
      error instanceof SocialProviderError &&
      error.detail.code !== "UPLOAD_OUTCOME_UNKNOWN" &&
      (error.detail.kind === "RATE_LIMITED" || error.detail.kind === "TRANSIENT");
    const status = retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
    const code = safeErrorCode(error);
    const message = safeErrorMessage(error);
    await this.db.$transaction(async (tx) => {
      await tx.publishAttempt.update({
        where: { workspaceId_id: { workspaceId, id: attemptId } },
        data: {
          status,
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        },
      });
      await tx.publishingDestination.update({
        where: { workspaceId_id: { workspaceId, id: destination.id } },
        data: { status, lastErrorCode: code, lastErrorMessage: message },
      });
      await tx.publishJob.update({
        where: { workspaceId_id: { workspaceId, id: jobId } },
        data: { status, nextAttemptAt: retryable ? new Date(Date.now() + 30_000) : null },
      });
      await this.updateParentStatus(tx, workspaceId, destination.scheduledPostId);
    });
  }

  private async markReconciliationRequired(
    workspaceId: string,
    destination: DestinationRecord,
    jobId: string,
    attemptId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.publishAttempt.update({
        where: { workspaceId_id: { workspaceId, id: attemptId } },
        data: {
          status: "RECONCILIATION_REQUIRED",
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        },
      });
      await tx.publishingDestination.update({
        where: { workspaceId_id: { workspaceId, id: destination.id } },
        data: { status: "RECONCILIATION_REQUIRED", lastErrorCode: code, lastErrorMessage: message },
      });
      await tx.publishJob.update({
        where: { workspaceId_id: { workspaceId, id: jobId } },
        data: { status: "RECONCILIATION_REQUIRED", nextAttemptAt: null },
      });
      await this.updateParentStatus(tx, workspaceId, destination.scheduledPostId);
    });
  }

  private async setDestinationState(
    workspaceId: string,
    destinationId: string,
    jobId: string,
    status: "FAILED_RETRYABLE",
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.publishingDestination.update({
        where: { workspaceId_id: { workspaceId, id: destinationId } },
        data: { status },
      });
      await tx.publishJob.update({
        where: { workspaceId_id: { workspaceId, id: jobId } },
        data: { status },
      });
    });
  }

  private async updateParentStatus(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    scheduledPostId: string,
  ): Promise<void> {
    const destinations = await tx.publishingDestination.findMany({
      where: { workspaceId, scheduledPostId },
      select: { status: true },
    });
    const status = destinations.every((destination) => destination.status === "PUBLISHED")
      ? "PUBLISHED"
      : destinations.some((destination) => destination.status === "UPLOADING")
        ? "UPLOADING"
        : destinations.some((destination) => destination.status === "REMOTE_PROCESSING")
          ? "REMOTE_PROCESSING"
          : destinations.some((destination) => destination.status === "RECONCILIATION_REQUIRED")
            ? "RECONCILIATION_REQUIRED"
            : destinations.some((destination) => destination.status === "FAILED_RETRYABLE")
              ? "FAILED_RETRYABLE"
              : destinations.some((destination) => destination.status === "FAILED_FINAL")
                ? "FAILED_FINAL"
                : destinations.every((destination) => destination.status === "CANCELED")
                  ? "CANCELED"
                  : destinations.some((destination) => destination.status === "SCHEDULED")
                    ? "SCHEDULED"
                    : "DRAFT";
    await tx.scheduledPost.update({
      where: { workspaceId_id: { workspaceId, id: scheduledPostId } },
      data: { status },
    });
  }

  private async getVerifiedVideo(
    context: WorkspaceContext,
    destination: DestinationRecord,
  ): Promise<{ render: RenderRecord; manifest: RenderManifest; video: Buffer }> {
    const render = await this.db.renderJob.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: context.workspaceId,
          id: destination.scheduledPost.renderJobId,
        },
      },
      include: { sceneMediaJob: true, artifacts: true },
    });
    if (!render || render.status !== "SUCCEEDED" || render.expiredAt !== null)
      throw new ConflictException("A successful retained render is required to publish");
    const manifest = await this.composition.getManifest(context, render.id);
    const artifact = render.artifacts.find((item) => item.kind === "VIDEO");
    if (
      !artifact ||
      manifest.video.objectKey !== artifact.objectKey ||
      manifest.video.byteSize !== artifact.byteSize ||
      manifest.video.checksumSha256 !== artifact.checksumSha256
    )
      throw new ConflictException("The verified render video artifact is unavailable");
    const video = await this.storage.getObject({
      workspaceId: context.workspaceId,
      objectKey: artifact.objectKey,
    });
    if (
      video.byteLength !== artifact.byteSize ||
      createHash("sha256").update(video).digest("hex") !== artifact.checksumSha256
    )
      throw new ConflictException("The render video changed after M10 integrity verification");
    return { render, manifest, video };
  }

  private async requirePost(
    workspaceId: string,
    scheduledPostId: string,
  ): Promise<ScheduledPostRecord> {
    const post = await this.db.scheduledPost.findUnique({
      where: { workspaceId_id: { workspaceId, id: scheduledPostId } },
      include: postInclude,
    });
    if (!post) throw new NotFoundException("Scheduled post not found");
    return post;
  }

  private async requireDestination(
    workspaceId: string,
    destinationId: string,
  ): Promise<DestinationRecord> {
    const destination = await this.db.publishingDestination.findUnique({
      where: { workspaceId_id: { workspaceId, id: destinationId } },
      include: destinationInclude,
    });
    if (!destination) throw new NotFoundException("Publishing destination not found");
    return destination;
  }

  private async requireEditableBeforePublish(post: ScheduledPostRecord): Promise<void> {
    if (
      !post.destinations.every(
        (destination) => destination.status === "DRAFT" || destination.status === "SCHEDULED",
      ) ||
      post.destinations.some((destination) => (destination.publishJob?.attempts.length ?? 0) > 0)
    )
      throw new ConflictException("A publish attempt exists; metadata and schedule are immutable");
  }

  private parseDestinationMetadata(
    destination: DestinationRecord,
  ): YouTubeDestinationMetadata | null {
    if (destination.platform !== "YOUTUBE") return null;
    const parsed = YouTubeDestinationMetadataSchema.safeParse(destination.metadata);
    return parsed.success ? parsed.data : null;
  }

  private youtubeMetadata(destination: DestinationRecord): YouTubeDestinationMetadata {
    const metadata = this.parseDestinationMetadata(destination);
    if (metadata === null)
      throw new ServiceUnavailableException(
        "YouTube publishing is unavailable for this destination; Instagram remains fail-closed.",
      );
    return metadata;
  }

  private policyContext(destination: DestinationRecord): PublishingPolicyContext {
    return {
      workspaceId: destination.workspaceId,
      channelId: destination.scheduledPost.channelId,
      scheduledAt: destination.scheduledPost.scheduledAt,
      platform: destination.platform,
      destinationId: destination.id,
      idempotencyKey: destination.idempotencyKey,
    };
  }

  private decryptSession(
    workspaceId: string,
    jobId: string,
    attempt: NonNullable<LatestAttempt>,
  ): string {
    if (
      attempt.sessionCiphertext === null ||
      attempt.sessionNonce === null ||
      attempt.sessionTag === null ||
      attempt.sessionKeyVersion === null
    )
      throw new ConflictException("The resumable upload session is unavailable");
    return this.sessionVault.decrypt(
      {
        ciphertext: attempt.sessionCiphertext,
        nonce: attempt.sessionNonce,
        tag: attempt.sessionTag,
        keyVersion: attempt.sessionKeyVersion as "env-v1",
      },
      this.sessionContext(workspaceId, jobId, attempt.id),
    );
  }

  private sessionContext(workspaceId: string, jobId: string, attemptId: string): string {
    return `${workspaceId}:${jobId}:${attemptId}:youtube-upload-session`;
  }

  private parseCalendarRange(from: string, to: string): { from: Date; to: Date } {
    const parsed = CalendarRangeSchema.safeParse({ from, to });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return { from: new Date(parsed.data.from), to: new Date(parsed.data.to) };
  }

  private requirePassingPreflight(preflight: PublishingPreflightView): void {
    if (!preflight.canPublish) {
      const reasons = preflight.gates
        .filter((item) => !item.passed)
        .map((item) => `${item.id}: ${item.evidence.join(" ")}`);
      throw new ConflictException(`Publishing is blocked. ${reasons.join(" ")}`);
    }
  }

  private presentPost(post: ScheduledPostRecord): ScheduledPostView {
    return {
      id: post.id,
      channelId: post.channelId,
      renderJobId: post.renderJobId,
      qualityReviewRunId: post.qualityReviewRunId,
      revision: post.revision,
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      status: post.status,
      disclosureDecision: post.disclosureDecision,
      disclosureText: post.disclosureText,
      disclosureReason: post.disclosureReason,
      manuallyAuthorizedAt: post.manuallyAuthorizedAt?.toISOString() ?? null,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      destinations: post.destinations.map((destination) => {
        const attempt = destination.publishJob?.attempts[0] ?? null;
        return this.presentDestination(destination, attempt);
      }),
    };
  }

  private presentDestination(
    destination: PresentedDestinationRecord,
    attempt: LatestAttempt,
  ): PublishingDestinationView {
    return {
      id: destination.id,
      platform: destination.platform,
      socialAccountId: destination.socialAccountId,
      status: destination.status,
      remotePostId: destination.remotePostId,
      publishedAt: destination.publishedAt?.toISOString() ?? null,
      lastErrorCode: destination.lastErrorCode,
      lastErrorMessage: destination.lastErrorMessage,
      metadata: destination.metadata,
      idempotencyKey: destination.idempotencyKey,
      latestAttempt:
        attempt === null
          ? null
          : {
              id: attempt.id,
              attemptNumber: attempt.attemptNumber,
              status: attempt.status,
              confirmedBytes: attempt.confirmedBytes.toString(),
              totalBytes: attempt.totalBytes?.toString() ?? null,
              remotePostId: attempt.remotePostId,
              errorCode: attempt.errorCode,
              errorMessage: attempt.errorMessage,
              startedAt: attempt.startedAt.toISOString(),
              finishedAt: attempt.finishedAt?.toISOString() ?? null,
            },
    };
  }

  private requireEditor(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Owner or editor permission required");
  }
}

function gate(
  id: PublishingPreflightGate["id"],
  passed: boolean,
  evidence: string,
): PublishingPreflightGate {
  return { id, passed, evidence: [evidence] };
}

function isExpectedPreflightError(error: unknown): boolean {
  return (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException ||
    error instanceof ServiceUnavailableException
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof SocialProviderError) return error.detail.message;
  return error instanceof Error ? error.message : "Publishing preflight failed";
}

function safeErrorCode(error: unknown): string {
  return error instanceof SocialProviderError ? error.detail.code : "PUBLISH_OPERATION_FAILED";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof SocialProviderError
    ? error.detail.message
    : "Publishing failed; reconcile any persisted upload session before retrying.";
}
