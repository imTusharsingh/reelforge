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
import { isCompletePackage } from "../scene-media/scene-media.validation.js";
import { ScriptService } from "../script/script.service.js";
import { scriptDocumentSchema } from "../script/script.validation.js";
import type { ScheduledPostView } from "../publishing/publishing.types.js";
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
    if (existingScriptId !== null)
      return this.scriptResult(input, existingScriptId, input.previousResultRef === null);
    // ScriptService.generate takes no idempotency key: reuse the script an earlier attempt of
    // this step already persisted instead of generating a second one.
    if (input.previousResultRef !== null)
      return this.scriptResult(input, input.previousResultRef, false);
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
    return this.scriptResult(input, scriptId, false);
  }

  private async scriptResult(
    input: WorkflowStepDispatchInput,
    scriptId: string,
    provided: boolean,
  ): Promise<WorkflowStepDispatchResult> {
    const script = record(await this.scripts.get(input.context, scriptId));
    return this.scriptStatusResult(scriptId, script["status"], provided);
  }

  /**
   * Scene media only accepts an approved script (M07 gate), so a generated or revised script is
   * an external wait for that human approval rather than a step that fails downstream with 409.
   */
  private scriptStatusResult(
    scriptId: string,
    status: unknown,
    provided: boolean,
  ): WorkflowStepDispatchResult {
    const output = { scriptId };
    if (status === "APPROVED")
      return {
        resultRef: scriptId,
        resultType: "SCRIPT",
        output,
        ...(provided ? { skipped: true } : {}),
      };
    if (status === "DRAFT" || status === "REVISION_PENDING")
      return {
        resultRef: scriptId,
        resultType: "SCRIPT",
        output,
        waitingExternal: { reason: `script ${scriptId} awaiting approval` },
      };
    throw new WorkflowStepError(
      "SCRIPT_REJECTED",
      `Script is ${String(status).toLowerCase()}; create a new run or revise the script`,
      false,
    );
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

  /** B3: only a complete package is success; generating is a wait; incomplete terminal fails. */
  private sceneResult(pkg: SceneMediaPackage): WorkflowStepDispatchResult {
    const output = {
      sceneMediaJobId: pkg.jobId,
      sceneMediaScriptId: pkg.scriptId,
      sceneMediaScriptRevision: pkg.scriptRevision,
    };
    if (isCompletePackage(pkg))
      return { resultRef: pkg.jobId, resultType: "SCENE_MEDIA_PACKAGE", output };
    if (pkg.status === "QUEUED" || pkg.status === "RUNNING")
      return {
        resultRef: pkg.jobId,
        resultType: "SCENE_MEDIA_PACKAGE",
        output,
        waitingExternal: { reason: `scene media ${pkg.status.toLowerCase()}` },
      };
    throw new WorkflowStepError(
      pkg.status === "FAILED" ? "SCENE_MEDIA_FAILED" : "SCENE_MEDIA_INCOMPLETE",
      pkg.status === "FAILED"
        ? "Scene media generation failed; retry it in scene media, then retry this step"
        : `Scene media package is ${pkg.status.toLowerCase()} and incomplete; retry the failed scenes, then retry this step`,
      false,
    );
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

  /** B3: a queued or running render is an external wait, re-checked by the workflow poller. */
  private renderResult(renderJobId: string, status: string): WorkflowStepDispatchResult {
    if (status === "SUCCEEDED")
      return { resultRef: renderJobId, resultType: "RENDER_JOB", output: { renderJobId } };
    if (status === "QUEUED" || status === "RUNNING")
      return {
        resultRef: renderJobId,
        resultType: "RENDER_JOB",
        output: { renderJobId },
        waitingExternal: { reason: `render ${status.toLowerCase()}` },
      };
    throw new WorkflowStepError(
      `RENDER_${status}`,
      `Render is ${status.toLowerCase()}; handle it in composition, then retry this step`,
      false,
    );
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
    // QualityService.create takes no idempotency key: reuse this step's earlier review run.
    const existingReviewId =
      input.previousResultRef ?? stringValue(input.input, "qualityReviewRunId");
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

  /**
   * B3: the first attempt calls M13 publishNow (preflight, upload). Once an upload exists the step
   * only reads its status and calls M13 reconcile while it is remote-processing; it never calls
   * publishNow again.
   */
  private async publish(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    let destinationId = stringValue(input.input, "publishingDestinationId");
    const scheduledPostId = stringValue(input.input, "scheduledPostId");
    if (destinationId === null) {
      const post = await this.publishing.getScheduledPost(
        input.context,
        requiredString(input.input, "scheduledPostId"),
      );
      const destination = post.destinations[0];
      if (!destination)
        throw new WorkflowStepError(
          "DESTINATION_MISSING",
          "The scheduled post has no publishing destination",
          false,
        );
      destinationId = destination.id;
    }
    const started = input.input["publishStarted"] === true || input.previousResultRef !== null;
    let post: ScheduledPostView;
    if (!started) {
      post = await this.publishing.publishNow(input.context, destinationId);
    } else {
      const knownPostId = stringValue(input.input, "publishScheduledPostId") ?? scheduledPostId;
      if (knownPostId === null)
        throw new WorkflowStepError(
          "PUBLISH_STATE_MISSING",
          "The scheduled post for the started upload is unknown",
          false,
          true,
        );
      post = await this.publishing.getScheduledPost(input.context, knownPostId);
      const current = post.destinations.find((item) => item.id === destinationId);
      if (current?.status === "REMOTE_PROCESSING")
        post = await this.publishing.reconcile(input.context, destinationId);
    }
    const destination = post.destinations.find((item) => item.id === destinationId);
    const status = destination?.status ?? post.status;
    const output = {
      publishingDestinationId: destinationId,
      publishScheduledPostId: post.id,
      publishStarted: true,
      publishStatus: status,
    };
    if (status === "PUBLISHED")
      return { resultRef: destinationId, resultType: "PUBLISHING_DESTINATION", output };
    if (status === "PREFLIGHT" || status === "UPLOADING" || status === "REMOTE_PROCESSING")
      return {
        resultRef: destinationId,
        resultType: "PUBLISHING_DESTINATION",
        output,
        waitingExternal: { reason: `publish ${status.toLowerCase()}` },
      };
    if (status === "RECONCILIATION_REQUIRED")
      throw new WorkflowStepError(
        "PUBLISH_RECONCILIATION_REQUIRED",
        "Publishing requires reconciliation before retry",
        false,
        true,
      );
    throw new WorkflowStepError(
      `PUBLISH_${status}`,
      `Publishing destination is ${status.toLowerCase()}; resolve it in publishing, then retry this step`,
      false,
    );
  }

  private async analyticsFollowUp(
    input: WorkflowStepDispatchInput,
  ): Promise<WorkflowStepDispatchResult> {
    // scheduleCollection takes no idempotency key: an earlier attempt's job is reused.
    if (input.previousResultRef !== null)
      return {
        resultRef: input.previousResultRef,
        resultType: "METRIC_COLLECTION_JOB",
        output: { analyticsJobId: input.previousResultRef },
      };
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
