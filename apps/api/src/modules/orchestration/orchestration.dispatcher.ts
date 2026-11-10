import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
import type { Database } from "../identity/identity.types.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { ChannelService } from "../channel/channel.service.js";
import { CompositionService } from "../composition/composition.service.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import { IdeaService } from "../idea/idea.service.js";
import { PublishingService } from "../publishing/publishing.service.js";
import { QualityService } from "../quality/quality.service.js";
import { SceneMediaService } from "../scene-media/scene-media.service.js";
import type { SceneMediaPackage } from "../scene-media/scene-media.types.js";
import { ScriptService } from "../script/script.service.js";
import { scriptDocumentSchema } from "../script/script.validation.js";
import {
  WorkflowStepError,
  type WorkflowRunInput,
  type WorkflowStepDispatchInput,
  type WorkflowStepDispatchResult,
  type WorkflowStepDispatcherPort,
} from "./orchestration.types.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(input: WorkflowRunInput, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(input: WorkflowRunInput, key: string): string {
  const value = stringValue(input, key);
  if (value === null)
    throw new WorkflowStepError(
      "MISSING_INPUT",
      `${key} is required for this workflow step`,
      false,
    );
  return value;
}

function mergeOutput(
  input: WorkflowRunInput,
  output: Readonly<Record<string, unknown>> | undefined,
): WorkflowRunInput {
  if (output === undefined) return input;
  return { ...input, ...output };
}

@Injectable()
export class WorkflowDomainDispatcher implements WorkflowStepDispatcherPort {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly channels: ChannelService,
    private readonly ideas: IdeaService,
    private readonly scripts: ScriptService,
    private readonly sceneMedia: SceneMediaService,
    private readonly composition: CompositionService,
    private readonly quality: QualityService,
    private readonly publishing: PublishingService,
    private readonly analytics: AnalyticsService,
  ) {}

  public async dispatchStep(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    switch (input.stepKey) {
      case "VERIFY_CONTEXT":
        return this.verifyContext(input);
      case "SELECT_IDEA":
        return this.selectIdea(input);
      case "GENERATE_SCRIPT":
        return this.generateScript(input);
      case "GENERATE_SCENE_MEDIA":
        return this.generateSceneMedia(input);
      case "COMPOSE_RENDER":
        return this.composeRender(input);
      case "QUALITY_REVIEW":
        return this.qualityReview(input);
      case "PUBLISH":
        return this.publish(input);
      case "ANALYTICS_FOLLOW_UP":
        return this.analyticsFollowUp(input);
      default:
        return assertNever(input.stepKey);
    }
  }

  private async verifyContext(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const channelId = requiredString(input.input, "channelId");
    const channel = await this.channels.get(input.context, channelId);
    if (channel.status === "ARCHIVED")
      throw new WorkflowStepError("CHANNEL_ARCHIVED", "Channel is archived", false);
    if (input.trigger === "SCHEDULED" && channel.status !== "ACTIVE")
      throw new WorkflowStepError(
        "CHANNEL_PAUSED",
        `Channel is ${channel.status.toLowerCase()} and cannot start autonomous work`,
        false,
      );
    return { resultRef: channelId, resultType: "CHANNEL" };
  }

  private async selectIdea(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    const existingSnapshotId = stringValue(input.input, "approvedIdeaSnapshotId");
    const ideaId = stringValue(input.input, "ideaId");
    if (existingSnapshotId !== null) {
      const checksum = stringValue(input.input, "approvedIdeaChecksum");
      if (checksum === null)
        throw new WorkflowStepError(
          "MISSING_INPUT",
          "approvedIdeaChecksum is required with approvedIdeaSnapshotId",
          false,
        );
      return {
        resultRef: existingSnapshotId,
        resultType: "IDEA_APPROVAL_SNAPSHOT",
        output: { approvedIdeaSnapshotId: existingSnapshotId, approvedIdeaChecksum: checksum },
      };
    }
    if (ideaId === null)
      throw new WorkflowStepError("MISSING_INPUT", "ideaId is required to select an idea", false);
    const approved = await this.ideas.getApproved(input.context, ideaId);
    return {
      resultRef: approved.id,
      resultType: "IDEA_APPROVAL_SNAPSHOT",
      output: {
        ideaId: approved.ideaId,
        approvedIdeaSnapshotId: approved.id,
        approvedIdeaChecksum: approved.checksumSha256,
        ideaTopic: approved.topic,
        ideaHook: approved.hook,
        ideaAngle: approved.angle,
        ideaAudience: approved.audience,
      },
    };
  }

  private async generateScript(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const existingScriptId = stringValue(input.input, "scriptId");
    if (existingScriptId !== null) {
      await this.scripts.get(input.context, existingScriptId);
      return {
        resultRef: existingScriptId,
        resultType: "SCRIPT",
        output: { scriptId: existingScriptId },
        skipped: true,
      };
    }
    const approvedIdeaSnapshotId = requiredString(input.input, "approvedIdeaSnapshotId");
    const approvedIdeaChecksum = requiredString(input.input, "approvedIdeaChecksum");
    const configSnapshotId = requiredString(input.input, "configSnapshotId");
    const promptSnapshotId = requiredString(input.input, "promptSnapshotId");
    const prompt =
      stringValue(input.input, "prompt") ??
      [
        `Write a short-form video script.`,
        `Topic: ${stringValue(input.input, "ideaTopic") ?? "the approved idea"}.`,
        `Hook: ${stringValue(input.input, "ideaHook") ?? ""}.`,
        `Angle: ${stringValue(input.input, "ideaAngle") ?? ""}.`,
        `Audience: ${stringValue(input.input, "ideaAudience") ?? ""}.`,
      ].join(" ");
    const result = record(
      await this.scripts.generate(input.context, {
        approvedIdeaSnapshotId,
        approvedIdeaChecksum,
        prompt,
        channelId: stringValue(input.input, "channelId") ?? undefined,
        correlationId: input.correlationId,
        configSnapshotId,
        promptSnapshotId,
      }),
    );
    const scriptId = typeof result["id"] === "string" ? result["id"] : null;
    if (scriptId === null)
      throw new WorkflowStepError(
        "SCRIPT_RESULT_INVALID",
        "Script service did not return a script id",
        false,
      );
    return { resultRef: scriptId, resultType: "SCRIPT", output: { scriptId } };
  }

  private async generateSceneMedia(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const existingJobId = stringValue(input.input, "sceneMediaJobId");
    if (existingJobId !== null) {
      const pkg = await this.sceneMedia.get(input.context, existingJobId);
      return this.sceneResult(pkg);
    }
    const scriptId = requiredString(input.input, "scriptId");
    const outputs = record(input.input["outputs"]);
    const requested = {
      image: true as const,
      video: outputs["video"] === true,
      narration: outputs["narration"] === true,
      dialogue: outputs["dialogue"] === true,
    };
    const pkg = await this.sceneMedia.create(input.context, {
      scriptId,
      idempotencyKey: input.idempotencyKey,
      outputs: requested,
    });
    return this.sceneResult(pkg);
  }

  private sceneResult(pkg: SceneMediaPackage): WorkflowStepDispatchResult {
    if (pkg.status === "FAILED")
      throw new WorkflowStepError("SCENE_MEDIA_FAILED", "Scene media generation failed", true);
    return {
      resultRef: pkg.jobId,
      resultType: "SCENE_MEDIA_PACKAGE",
      output: {
        sceneMediaJobId: pkg.jobId,
        sceneMediaScriptId: pkg.scriptId,
        sceneMediaScriptRevision: pkg.scriptRevision,
      },
    };
  }

  private async composeRender(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const existingRenderId = stringValue(input.input, "renderJobId");
    if (existingRenderId !== null) {
      const render = await this.composition.get(input.context, existingRenderId);
      return this.renderResult(render.id, render.status);
    }
    const rawInput = input.input["renderInput"];
    const renderInput = rawInput === undefined ? await this.deriveRenderInput(input) : rawInput;
    const result = await this.composition.create(input.context, {
      idempotencyKey: input.idempotencyKey,
      input: renderInput,
      retentionDays: 90,
    });
    return this.renderResult(result.id, result.status);
  }

  private renderResult(renderJobId: string, status: string): WorkflowStepDispatchResult {
    if (status === "FAILED_FINAL")
      throw new WorkflowStepError("RENDER_FAILED_FINAL", "Render failed permanently", false);
    if (status === "FAILED_RETRYABLE")
      throw new WorkflowStepError("RENDER_FAILED_RETRYABLE", "Render failed temporarily", true);
    if (status !== "SUCCEEDED")
      throw new WorkflowStepError("RENDER_NOT_READY", `Render is ${status.toLowerCase()}`, true);
    return { resultRef: renderJobId, resultType: "RENDER_JOB", output: { renderJobId } };
  }

  private async deriveRenderInput(
    input: WorkflowStepDispatchInput,
  ): Promise<RenderCompositionInput> {
    const sceneMediaJobId = requiredString(input.input, "sceneMediaJobId");
    const pkg = await this.sceneMedia.exportPackage(input.context, sceneMediaJobId);
    const script = record(await this.scripts.get(input.context, pkg.scriptId));
    const revisions = Array.isArray(script["revisions"]) ? script["revisions"] : [];
    const revision = record(revisions[0]);
    const parsed = scriptDocumentSchema.safeParse(revision["document"]);
    if (!parsed.success)
      throw new WorkflowStepError(
        "SCRIPT_DOCUMENT_INVALID",
        "The approved script revision cannot be rendered",
        false,
      );
    const document = parsed.data;
    const scenes = pkg.scenes.map((scene) => {
      const image = scene.outputs.find(
        (output) =>
          output.kind === "IMAGE" && output.assetId !== null && output.assetVersion !== null,
      );
      if (!image || image.assetId === null || image.assetVersion === null)
        throw new WorkflowStepError(
          "SCENE_ASSET_MISSING",
          `Scene ${scene.sceneId} has no generated image`,
          false,
        );
      const scriptScene = document.scenes.find((item) => item.id === scene.sceneId);
      return {
        sceneId: scene.sceneId,
        assetId: image.assetId,
        assetVersion: image.assetVersion,
        image: true,
        durationMs: Math.max(100, Math.round((scriptScene?.durationSeconds ?? 1) * 1000)),
        captions: [],
      };
    });
    if (scenes.length === 0)
      throw new WorkflowStepError("SCENE_PACKAGE_EMPTY", "The scene package is empty", false);
    const first = scenes[0];
    if (!first)
      throw new WorkflowStepError("SCENE_PACKAGE_EMPTY", "The scene package is empty", false);
    return {
      schemaVersion: "1.0",
      title: document.title,
      profile: DEFAULT_RENDER_PROFILE,
      sourceMediaPackage: {
        jobId: pkg.jobId,
        scriptId: pkg.scriptId,
        scriptRevision: pkg.scriptRevision,
        schemaVersion: "1.0",
      },
      scenes,
      audio: [],
      coverFrames: [{ assetId: first.assetId, assetVersion: first.assetVersion, timestampMs: 0 }],
      renderSeed: `${input.runId}-${input.stepId}`,
    };
  }

  private async qualityReview(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const existingReviewId = stringValue(input.input, "qualityReviewRunId");
    const review =
      existingReviewId !== null
        ? await this.quality.get(input.context, existingReviewId)
        : await this.quality.create(input.context, {
            renderJobId: requiredString(input.input, "renderJobId"),
          });
    if (review.status === "APPROVED" || review.status === "AUTO_APPROVED")
      return {
        resultRef: review.id,
        resultType: "QUALITY_REVIEW_RUN",
        output: { qualityReviewRunId: review.id, qualityStatus: review.status },
      };
    if (review.status === "REVIEW_REQUIRED" || review.status === "AI_REVIEW_UNAVAILABLE")
      return {
        resultRef: review.id,
        resultType: "QUALITY_REVIEW_RUN",
        output: { qualityReviewRunId: review.id, qualityStatus: review.status },
        waitingApproval: true,
      };
    throw new WorkflowStepError(
      review.status === "BLOCKED" ? "QUALITY_BLOCKED" : "QUALITY_REJECTED",
      `Quality review is ${review.status.toLowerCase()}`,
      false,
    );
  }

  private async publish(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    let destinationId = stringValue(input.input, "publishingDestinationId");
    if (destinationId === null) {
      const scheduledPostId = requiredString(input.input, "scheduledPostId");
      const post = await this.publishing.getScheduledPost(input.context, scheduledPostId);
      const destination = post.destinations[0];
      if (!destination)
        throw new WorkflowStepError(
          "DESTINATION_MISSING",
          "The scheduled post has no publishing destination",
          false,
        );
      destinationId = destination.id;
    }
    const post = await this.publishing.publishNow(input.context, destinationId);
    const destination = post.destinations.find((item) => item.id === destinationId);
    const status = destination?.status ?? post.status;
    if (status === "PUBLISHED")
      return {
        resultRef: destinationId,
        resultType: "PUBLISHING_DESTINATION",
        output: {
          publishingDestinationId: destinationId,
          scheduledPostId: post.id,
          publishStatus: status,
        },
      };
    if (status === "RECONCILIATION_REQUIRED")
      throw new WorkflowStepError(
        "PUBLISH_RECONCILIATION_REQUIRED",
        "Publishing requires reconciliation before retry",
        false,
        true,
      );
    throw new WorkflowStepError(
      "PUBLISH_PENDING",
      `Publishing destination is ${status.toLowerCase()}`,
      true,
    );
  }

  private async analyticsFollowUp(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    const result = await this.analytics.scheduleCollection(input.context, {
      channelId: requiredString(input.input, "channelId"),
      socialAccountId: requiredString(input.input, "socialAccountId"),
      startDate: requiredString(input.input, "analyticsStartDate"),
      endDate: requiredString(input.input, "analyticsEndDate"),
    });
    return {
      resultRef: result.id,
      resultType: "METRIC_COLLECTION_JOB",
      output: { analyticsJobId: result.id },
    };
  }
}

function assertNever(value: never): never {
  throw new BadRequestException(`Unsupported workflow step ${String(value)}`);
}

export function mergeStepOutput(
  input: WorkflowRunInput,
  output: Readonly<Record<string, unknown>> | undefined,
): WorkflowRunInput {
  return mergeOutput(input, output);
}
