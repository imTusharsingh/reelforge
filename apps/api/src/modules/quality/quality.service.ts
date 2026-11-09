import { randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@reelforge/database";
import {
  ProviderError,
  QUALITY_REVIEW_PORT,
  type QualityReviewPort,
  type QualityReviewRequest,
} from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { CompositionService } from "../composition/composition.service.js";
import { createRenderSchema } from "../composition/composition.validation.js";
import type { RenderManifest } from "../composition/composition.manifest.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import { validateGenrePolicy, scriptDocumentSchema } from "../script/script.validation.js";
import type { ScriptDocument } from "../script/script.types.js";
import type {
  ApprovalPolicy,
  HardGateId,
  HardGateResult,
  QualityRunView,
  QualityRunStatus,
  QualityDecisionAction,
  QualityScorecard,
} from "./quality.types.js";
import {
  approvalPolicySchema,
  decisionSchema,
  hardGateSummarySchema,
  parseApprovalPolicy,
  QUALITY_CRITERIA,
  qualityReviewResultSchema,
  qualityScorecardSchema,
} from "./quality.validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const qualityInputSchema = createRenderSchema.shape.input;

@Injectable()
export class QualityService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly composition: CompositionService,
    @Inject(QUALITY_REVIEW_PORT) private readonly aiReview: QualityReviewPort,
  ) {}

  public async create(context: WorkspaceContext, body: unknown): Promise<QualityRunView> {
    this.requireEditor(context);
    const request = parseCreateBody(body);
    const job = await this.db.renderJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: request.renderJobId } },
      include: { sceneMediaJob: { include: { channel: true } } },
    });
    if (!job) throw new NotFoundException("Render job not found");

    const parsedInput = qualityInputSchema.safeParse(job.input);
    const input = parsedInput.success ? parsedInput.data : null;
    const gates: HardGateResult[] = [];
    let manifest: RenderManifest | null = null;
    let manifestError: string | null = null;
    if (input) {
      try {
        manifest = await this.composition.getManifest(context, job.id);
      } catch (error) {
        if (
          error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof NotFoundException
        ) {
          manifestError = error.message;
        } else {
          throw error;
        }
      }
    } else {
      manifestError = "Persisted render input does not match the M10 schema";
    }

    gates.push(
      gate(
        "ARTIFACT_INTEGRITY",
        manifest !== null,
        manifest
          ? ["M10 verified the stored manifest, artifact set, sizes, and SHA-256 checksums"]
          : [manifestError ?? "A validated M10 manifest is unavailable"],
      ),
    );

    const profile = manifest?.renderProfile;
    const aspectRatioPass =
      profile !== undefined &&
      profile.width === 1080 &&
      profile.height === 1920 &&
      profile.width * 16 === profile.height * 9;
    gates.push(
      gate(
        "ASPECT_RATIO",
        aspectRatioPass,
        aspectRatioPass
          ? ["M10 validated the pinned 1080x1920 (9:16) output profile"]
          : ["Verified M10 output profile is missing or is not 9:16"],
      ),
    );

    const expectedDurationMs = input
      ? input.scenes.reduce((sum, scene) => sum + scene.durationMs, 0) -
        (input.scenes.length - 1) * input.profile.transitionDurationMs
      : null;
    const durationPass =
      manifest !== null &&
      expectedDurationMs !== null &&
      Math.abs(manifest.video.durationMs - expectedDurationMs) <= 50;
    gates.push(
      gate(
        "DURATION",
        durationPass,
        durationPass && manifest !== null && expectedDurationMs !== null
          ? [
              `M10 duration ${manifest.video.durationMs}ms matches pinned duration ${expectedDurationMs}ms within 50ms`,
            ]
          : ["Verified M10 duration is missing or outside the pinned duration tolerance"],
      ),
    );

    const codecPass = profile?.videoCodec === "h264" && manifest?.video.mediaType === "video/mp4";
    gates.push(
      gate(
        "VIDEO_CODEC",
        codecPass,
        codecPass
          ? ["M10 validated H.264 video in an MP4 artifact"]
          : ["Verified M10 video codec or container does not match the required profile"],
      ),
    );

    const audioPass =
      profile?.audioCodec === "aac" &&
      profile.audioSampleRate === 48_000 &&
      profile.audioChannels === 2;
    gates.push(
      gate(
        "AUDIO",
        audioPass,
        audioPass
          ? [
              "M10 validated AAC audio at 48kHz stereo, including a track when no source audio was pinned",
            ]
          : [
              "Verified M10 audio profile is missing or does not meet the required codec/sample/channel profile",
            ],
      ),
    );

    const subtitlesPass =
      input !== null &&
      input.profile.captionSafeMarginPixels >= 24 &&
      input.scenes.every((scene) =>
        scene.captions.every((caption, index) => {
          const previous = scene.captions[index - 1];
          return (
            caption.startMs >= 0 &&
            caption.endMs > caption.startMs &&
            caption.endMs <= scene.durationMs &&
            (previous === undefined || caption.startMs >= previous.endMs)
          );
        }),
      );
    gates.push(
      gate(
        "SUBTITLES",
        subtitlesPass,
        subtitlesPass
          ? [
              input.scenes.some((scene) => scene.captions.length > 0)
                ? "Pinned subtitle intervals are ordered, non-overlapping, scene-bounded, and use the M10 safe-margin profile"
                : "No subtitle intervals were pinned; no subtitle track is required",
            ]
          : ["Pinned subtitle timing or safe-margin profile is invalid"],
      ),
    );

    const scriptRevision = await this.db.scriptRevision.findUnique({
      where: {
        workspaceId_scriptId_revision: {
          workspaceId: context.workspaceId,
          scriptId: job.sceneMediaJob.scriptId,
          revision: job.sceneMediaJob.scriptRevision,
        },
      },
      include: { script: { include: { snapshot: { select: { references: true } } } } },
    });
    const sourceRevisionMatches =
      input !== null &&
      scriptRevision !== null &&
      input.sourceMediaPackage.jobId === job.sceneMediaJob.id &&
      input.sourceMediaPackage.scriptId === job.sceneMediaJob.scriptId &&
      input.sourceMediaPackage.scriptRevision === job.sceneMediaJob.scriptRevision;
    gates.push(
      gate(
        "SCRIPT_PROVENANCE",
        sourceRevisionMatches,
        sourceRevisionMatches
          ? ["Rendered source package matches the workspace-pinned script revision"]
          : ["Rendered source package does not match the scene-media job's script revision"],
      ),
    );
    const script = scriptRevision ? parseScriptDocument(scriptRevision.document) : null;
    const genre = script
      ? await this.db.genre.findFirst({
          where: { workspaceId: context.workspaceId, name: script.metadata.genre },
          select: {
            name: true,
            topicsAllowed: true,
            topicsBlocked: true,
            safetyProfile: true,
          },
        })
      : null;
    let allowedTopics: string[] = [];
    let blockedTopics: string[] = [];
    const policyEvidence: string[] = [];
    let genrePass = script !== null && genre !== null;
    if (!script) policyEvidence.push("The exact script revision is missing or invalid");
    if (script && !genre)
      policyEvidence.push("The script genre is not configured in this workspace");
    if (genre && script) {
      const allowed = stringArray(genre.topicsAllowed);
      const blocked = stringArray(genre.topicsBlocked);
      if (!allowed || !blocked) {
        genrePass = false;
        policyEvidence.push("Genre allowed/blocked topic policy is not a string array");
      } else {
        allowedTopics = allowed;
        blockedTopics = blocked;
        const searchableText = normalizePolicyText(
          [
            scriptText(script),
            input?.title ?? "",
            ...(input?.scenes.flatMap((scene) => scene.captions.map((caption) => caption.text)) ??
              []),
          ].join("\n"),
        );
        const blockedMatch = blocked.find((term) =>
          searchableText.includes(normalizePolicyText(term)),
        );
        if (blockedMatch) {
          genrePass = false;
          policyEvidence.push(`Script contains a configured blocked topic: ${blockedMatch}`);
        }
        try {
          validateGenrePolicy(
            script,
            { safetyProfile: genre.safetyProfile },
            scriptRevision?.script.snapshot.references,
          );
          policyEvidence.push("Factuality and approved-source requirements match the genre policy");
        } catch (error) {
          if (error instanceof ConflictException) {
            genrePass = false;
            policyEvidence.push(error.message);
          } else {
            throw error;
          }
        }
      }
    }
    gates.push(
      gate(
        "GENRE_POLICY",
        genrePass,
        policyEvidence.length > 0
          ? policyEvidence
          : ["Script, genre, and factuality policy are present and compatible"],
      ),
    );

    let approvalPolicy: ApprovalPolicy;
    let approvalPolicyValid = true;
    const approvalPolicyEvidence: string[] = [];
    try {
      approvalPolicy = parseApprovalPolicy(job.sceneMediaJob.channel?.approvalPolicy);
      approvalPolicyEvidence.push(
        `Approval mode ${approvalPolicy.mode}; score threshold ${approvalPolicy.scoreThreshold}`,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      approvalPolicyValid = false;
      approvalPolicy = { mode: "MANUAL", scoreThreshold: 80, criterionThresholds: {} };
      approvalPolicyEvidence.push(`Invalid channel approval policy: ${error.message}`);
    }
    gates.push(gate("APPROVAL_POLICY", approvalPolicyValid, approvalPolicyEvidence));

    const assetPairs = input ? collectAssetPairs(input) : [];
    const assetIds = [...new Set(assetPairs.map((asset) => asset.assetId))];
    const assets = assetIds.length
      ? await this.db.asset.findMany({
          where: { workspaceId: context.workspaceId, id: { in: assetIds } },
          select: {
            id: true,
            version: true,
            ownership: true,
            status: true,
            licenseType: true,
            licenseTerms: true,
            rightsHolder: true,
            rightsAttestedAt: true,
          },
        })
      : [];
    const usageReferences = assetIds.length
      ? await this.db.assetUsageReference.findMany({
          where: {
            workspaceId: context.workspaceId,
            usedByType: "render_input",
            usedById: job.id,
            assetId: { in: assetIds },
          },
          select: { assetId: true, assetVersion: true },
        })
      : [];
    const usedPairs = new Set(usageReferences.map((reference) => assetPairKey(reference)));
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const rightsProblems = assetPairs.flatMap((expected) => {
      const asset = assetById.get(expected.assetId);
      const problems: string[] = [];
      if (!asset || asset.version !== expected.assetVersion || asset.status !== "PUBLISHED")
        problems.push(
          `${expected.assetId}@${expected.assetVersion} is missing, unpinned, or unpublished`,
        );
      else if (
        !asset.licenseType?.trim() ||
        !asset.licenseTerms?.trim() ||
        !asset.rightsHolder?.trim() ||
        asset.rightsAttestedAt === null
      )
        problems.push(
          `${expected.assetId}@${expected.assetVersion} has incomplete rights attestation`,
        );
      if (!usedPairs.has(assetPairKey(expected)))
        problems.push(
          `${expected.assetId}@${expected.assetVersion} has no M10 render-input provenance record`,
        );
      return problems;
    });
    const rightsPass = assetPairs.length > 0 && rightsProblems.length === 0;
    gates.push(
      gate(
        "ASSET_RIGHTS",
        rightsPass,
        rightsPass
          ? [
              `Verified rights and M10 input provenance for ${assetPairs.length} pinned asset reference(s)`,
            ]
          : rightsProblems.length > 0
            ? rightsProblems
            : ["No pinned media assets were available for rights verification"],
      ),
    );
    const disclosures = [
      ...(assets.some((asset) => asset.ownership === "SYSTEM_GENERATED")
        ? ["AI_GENERATED_ASSET"]
        : []),
      ...(assets.some((asset) => asset.ownership === "STARTER_LIBRARY")
        ? ["STARTER_LIBRARY_ASSET"]
        : []),
    ];
    gates.push(
      gate(
        "DISCLOSURES",
        rightsPass,
        rightsPass
          ? disclosures.length > 0
            ? disclosures.map((disclosure) => `Required disclosure flag: ${disclosure}`)
            : ["No required disclosure flags apply to the verified pinned asset ownership"]
          : ["Disclosure flags cannot be derived until pinned asset provenance is verified"],
      ),
    );

    const allGatesPass = gates.every((result) => result.passed);
    let status: QualityRunStatus = allGatesPass ? "AI_REVIEW_UNAVAILABLE" : "BLOCKED";
    let scorecard: QualityScorecard | null = null;
    const limitations: string[] = [];
    if (allGatesPass && script && genre && input) {
      const request: QualityReviewRequest = {
        correlationId: randomUUID(),
        title: script.title,
        hook: script.hook,
        dialogue: script.dialogue,
        narration: script.narration ?? "",
        callToAction: script.cta,
        genre: genre.name,
        allowedTopics,
        blockedTopics,
        claims: script.claims ?? [],
        scenes: script.scenes.map((scene) => ({
          id: scene.id,
          dialogue: scene.dialogue,
          narration: scene.narration ?? "",
          visualDescription: scene.visualDescription,
          captions:
            input.scenes
              .find((renderScene) => renderScene.sceneId === scene.id)
              ?.captions.map((caption) => caption.text) ?? [],
        })),
        requiredDisclosures: disclosures,
      };
      try {
        const untrustedResult = await this.aiReview.review(request);
        const parsedResult = qualityReviewResultSchema.safeParse(untrustedResult);
        if (!parsedResult.success)
          throw new BadGatewayException("AI quality review returned an invalid structured result");
        const criteria = parsedResult.data.criteria;
        const scores = Object.values(criteria).map((criterion) => criterion.score);
        const computedScore = Math.round(
          scores.reduce((sum, item) => sum + item, 0) / scores.length,
        );
        const metadata = parsedResult.data.metadata;
        const normalizedMetadata = {
          modelVersion: metadata.modelVersion,
          promptVersion: metadata.promptVersion,
          cost: metadata.cost,
          ...(metadata.currency === undefined ? {} : { currency: metadata.currency }),
          ...(metadata.usage === undefined
            ? {}
            : {
                usage: {
                  ...(metadata.usage.inputTokens === undefined
                    ? {}
                    : { inputTokens: metadata.usage.inputTokens }),
                  ...(metadata.usage.outputTokens === undefined
                    ? {}
                    : { outputTokens: metadata.usage.outputTokens }),
                  ...(metadata.usage.seconds === undefined
                    ? {}
                    : { seconds: metadata.usage.seconds }),
                  ...(metadata.usage.characters === undefined
                    ? {}
                    : { characters: metadata.usage.characters }),
                },
              }),
        };
        scorecard = {
          criteria,
          score: computedScore,
          metadata: normalizedMetadata,
        };
        const criteriaMeetThresholds = QUALITY_CRITERIA.every((criterionKey) => {
          const result = criteria[criterionKey];
          return (
            result.score >=
            (approvalPolicy.criterionThresholds[criterionKey] ?? approvalPolicy.scoreThreshold)
          );
        });
        const allThresholdsMet =
          computedScore >= approvalPolicy.scoreThreshold && criteriaMeetThresholds;
        status =
          approvalPolicy.mode === "AUTO" && allThresholdsMet ? "AUTO_APPROVED" : "REVIEW_REQUIRED";
        limitations.push(...Object.values(criteria).flatMap((criterion) => criterion.limitations));
      } catch (error) {
        if (error instanceof ProviderError && error.code === "NOT_CONFIGURED") {
          status = "AI_REVIEW_UNAVAILABLE";
          limitations.push(
            "AI quality review is not configured; approval and publication remain blocked",
          );
        } else {
          throw error;
        }
      }
    }
    if (!allGatesPass)
      limitations.push("At least one hard gate failed; approval and auto-approval are blocked");

    const renderFamilyId = await this.renderFamilyId(context.workspaceId, job.id, job.parentJobId);
    const created = await this.db.qualityReviewRun.create({
      data: {
        workspaceId: context.workspaceId,
        renderJobId: job.id,
        renderFamilyId,
        createdByUserId: context.userId,
        status,
        gateSummary: gates as Prisma.InputJsonValue,
        scorecard: scorecard === null ? Prisma.JsonNull : (scorecard as Prisma.InputJsonValue),
        policySnapshot: approvalPolicy as Prisma.InputJsonValue,
        disclosures: disclosures as Prisma.InputJsonValue,
        limitations: limitations as Prisma.InputJsonValue,
        modelVersion: scorecard?.metadata.modelVersion ?? null,
        promptVersion: scorecard?.metadata.promptVersion ?? null,
      },
      select: { id: true },
    });
    return this.get(context, created.id);
  }

  public async queue(context: WorkspaceContext): Promise<QualityRunView[]> {
    const runs = await this.db.qualityReviewRun.findMany({
      where: { workspaceId: context.workspaceId, status: "REVIEW_REQUIRED" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
      include: { decisions: { orderBy: { createdAt: "asc" } }, regenerationRequests: true },
    });
    return runs.map((run) => this.present(run));
  }

  public async get(context: WorkspaceContext, runId: string): Promise<QualityRunView> {
    const run = await this.db.qualityReviewRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: runId } },
      include: { decisions: { orderBy: { createdAt: "asc" } }, regenerationRequests: true },
    });
    if (!run) throw new NotFoundException("Quality review run not found");
    return this.present(run);
  }

  public async decide(
    context: WorkspaceContext,
    runId: string,
    body: unknown,
  ): Promise<QualityRunView> {
    this.requireEditor(context);
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const decision = parsed.data;
    const statusByAction: Record<QualityDecisionAction, QualityRunStatus> = {
      APPROVE: "APPROVED",
      REJECT: "REJECTED",
      REQUEST_CHANGES: "CHANGES_REQUESTED",
    };
    const nextStatus = statusByAction[decision.action];
    const regeneration = decision.regeneration;
    if (decision.action === "REQUEST_CHANGES" && !regeneration)
      throw new BadRequestException("Request-changes decisions require a regeneration route");
    if (decision.action !== "REQUEST_CHANGES" && regeneration)
      throw new BadRequestException(
        "Regeneration routes are valid only for request-changes decisions",
      );

    try {
      await this.db.$transaction(
        async (tx) => {
          const run = await tx.qualityReviewRun.findUnique({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: runId } },
            include: { renderJob: { select: { input: true } } },
          });
          if (!run) throw new NotFoundException("Quality review run not found");
          if (run.status !== "REVIEW_REQUIRED")
            throw new ConflictException("Only a pending manual review can receive a decision");
          const gates = hardGateSummarySchema.safeParse(run.gateSummary);
          if (!gates.success)
            throw new InternalServerErrorException("Stored quality gate summary is invalid");
          if (decision.action === "APPROVE" && gates.data.some((result) => !result.passed))
            throw new ConflictException("A quality run with failed hard gates cannot be approved");

          let targetKey: string | null = null;
          let targetAttempt: number | null = null;
          if (regeneration?.stage === "SCENE") {
            const input = qualityInputSchema.safeParse(run.renderJob.input);
            if (
              !input.success ||
              !input.data.scenes.some((scene) => scene.sceneId === regeneration.sceneId)
            )
              throw new BadRequestException("Regeneration scene must belong to this pinned render");
            targetKey = `scene:${regeneration.sceneId}`;
          } else if (regeneration?.stage === "SCRIPT") {
            targetKey = "script";
          } else if (regeneration?.stage === "RENDER") {
            targetKey = "render";
          }

          if (targetKey !== null) {
            const count = await tx.qualityRegenerationRequest.count({
              where: {
                workspaceId: context.workspaceId,
                renderFamilyId: run.renderFamilyId,
                targetKey,
              },
            });
            if (count >= 3)
              throw new ConflictException(
                "The regeneration limit for this target has been reached",
              );
            targetAttempt = count + 1;
          }

          const claimed = await tx.qualityReviewRun.updateMany({
            where: {
              workspaceId: context.workspaceId,
              id: runId,
              status: "REVIEW_REQUIRED",
            },
            data: { status: nextStatus },
          });
          if (claimed.count !== 1)
            throw new ConflictException("The quality review was decided by another reviewer");
          const savedDecision = await tx.qualityDecision.create({
            data: {
              workspaceId: context.workspaceId,
              reviewRunId: runId,
              actorUserId: context.userId,
              action: decision.action,
              reason: decision.reason,
            },
            select: { id: true },
          });
          if (regeneration && targetKey !== null) {
            if (targetAttempt === null)
              throw new InternalServerErrorException("Regeneration attempt was not allocated");
            await tx.qualityRegenerationRequest.create({
              data: {
                workspaceId: context.workspaceId,
                reviewRunId: runId,
                renderJobId: run.renderJobId,
                renderFamilyId: run.renderFamilyId,
                decisionId: savedDecision.id,
                stage: regeneration.stage,
                targetKey,
                sceneId: regeneration.stage === "SCENE" ? regeneration.sceneId : null,
                attempt: targetAttempt,
              },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2002")
      )
        throw new ConflictException("Concurrent review or regeneration update; retry the request");
      throw error;
    }
    return this.get(context, runId);
  }

  private requireEditor(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Owner or editor permission required");
  }

  private async renderFamilyId(
    workspaceId: string,
    renderJobId: string,
    parentJobId: string | null,
  ): Promise<string> {
    let familyId = renderJobId;
    let parentId = parentJobId;
    const visited = new Set([renderJobId]);
    while (parentId !== null) {
      if (visited.has(parentId) || visited.size >= 100)
        throw new InternalServerErrorException("Render retry ancestry is invalid");
      visited.add(parentId);
      const parent = await this.db.renderJob.findUnique({
        where: { workspaceId_id: { workspaceId, id: parentId } },
        select: { id: true, parentJobId: true },
      });
      if (!parent) throw new InternalServerErrorException("Render retry parent is missing");
      familyId = parent.id;
      parentId = parent.parentJobId;
    }
    return familyId;
  }

  private present(run: {
    id: string;
    renderJobId: string;
    status: QualityRunStatus;
    gateSummary: Prisma.JsonValue;
    scorecard: Prisma.JsonValue | null;
    policySnapshot: Prisma.JsonValue;
    disclosures: Prisma.JsonValue;
    limitations: Prisma.JsonValue;
    createdAt: Date;
    decisions: Array<{
      id: string;
      action: QualityDecisionAction;
      reason: string;
      actorUserId: string;
      createdAt: Date;
    }>;
    regenerationRequests: Array<{
      id: string;
      stage: "SCENE" | "SCRIPT" | "RENDER";
      sceneId: string | null;
      attempt: number;
      createdAt: Date;
    }>;
  }): QualityRunView {
    const gateResults = hardGateSummarySchema.safeParse(run.gateSummary);
    const policy = safePolicySnapshot(run.policySnapshot);
    const disclosures = stringArray(run.disclosures);
    const limitations = stringArray(run.limitations);
    const score = run.scorecard === null ? null : qualityScorecardSchema.safeParse(run.scorecard);
    if (
      !gateResults.success ||
      !policy ||
      !disclosures ||
      !limitations ||
      (score !== null && !score.success)
    )
      throw new InternalServerErrorException("Stored quality review data is invalid");
    return {
      id: run.id,
      renderJobId: run.renderJobId,
      status: run.status,
      gateSummary: gateResults.data,
      scorecard: score === null ? null : (score.data as QualityScorecard),
      policySnapshot: policy,
      disclosures,
      limitations,
      decisions: run.decisions.map((decision) => ({
        id: decision.id,
        action: decision.action,
        reason: decision.reason,
        actorUserId: decision.actorUserId,
        createdAt: decision.createdAt.toISOString(),
      })),
      regenerationRequests: run.regenerationRequests.map((request) => ({
        id: request.id,
        stage: request.stage,
        sceneId: request.sceneId,
        attempt: request.attempt,
        createdAt: request.createdAt.toISOString(),
      })),
      createdAt: run.createdAt.toISOString(),
    };
  }
}

function parseCreateBody(body: unknown): { renderJobId: string } {
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

function parseScriptDocument(value: unknown): ScriptDocument | null {
  const parsed = scriptDocumentSchema.safeParse(value);
  if (!parsed.success) return null;
  const document = parsed.data;
  return {
    schemaVersion: document.schemaVersion,
    title: document.title,
    hook: document.hook,
    dialogue: document.dialogue,
    ...(document.narration === undefined ? {} : { narration: document.narration }),
    cta: document.cta,
    metadata: document.metadata,
    scenes: document.scenes.map((scene) => ({
      id: scene.id,
      startSeconds: scene.startSeconds,
      durationSeconds: scene.durationSeconds,
      characterRefs: scene.characterRefs,
      dialogue: scene.dialogue,
      ...(scene.narration === undefined ? {} : { narration: scene.narration }),
      visualDescription: scene.visualDescription,
      camera: scene.camera,
      audioCues: scene.audioCues,
      ...(scene.transition === undefined ? {} : { transition: scene.transition }),
    })),
    ...(document.claims === undefined
      ? {}
      : {
          claims: document.claims.map((claim) => ({
            text: claim.text,
            sourceUrl: claim.sourceUrl,
          })),
        }),
  };
}

function gate(id: HardGateId, passed: boolean, evidence: string[]): HardGateResult {
  return { id, passed, evidence };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  if (strings.length !== value.length || strings.some((entry) => entry.trim().length === 0))
    return null;
  return strings.map((entry) => entry.trim());
}

function scriptText(script: ScriptDocument): string {
  return [
    script.title,
    script.hook,
    script.dialogue,
    script.narration ?? "",
    script.cta,
    ...(script.claims?.map((claim) => claim.text) ?? []),
    ...script.scenes.flatMap((scene) => [
      scene.dialogue,
      scene.narration ?? "",
      scene.visualDescription,
      scene.camera,
      ...scene.audioCues,
    ]),
  ].join("\n");
}

function normalizePolicyText(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

function collectAssetPairs(
  input: RenderCompositionInput,
): Array<{ assetId: string; assetVersion: number }> {
  return [
    ...input.scenes.flatMap((scene) => [
      { assetId: scene.assetId, assetVersion: scene.assetVersion },
      ...(scene.narrationAssetId && scene.narrationAssetVersion
        ? [{ assetId: scene.narrationAssetId, assetVersion: scene.narrationAssetVersion }]
        : []),
    ]),
    ...input.audio.map((audio) => ({ assetId: audio.assetId, assetVersion: audio.assetVersion })),
  ].filter(
    (asset, index, list) =>
      list.findIndex(
        (candidate) =>
          candidate.assetId === asset.assetId && candidate.assetVersion === asset.assetVersion,
      ) === index,
  );
}

function assetPairKey(asset: { assetId: string; assetVersion: number }): string {
  return `${asset.assetId}@${asset.assetVersion}`;
}

function safePolicySnapshot(value: Prisma.JsonValue): QualityRunView["policySnapshot"] | null {
  const parsed = approvalPolicySchema.safeParse(value);
  return parsed.success ? parseApprovalPolicy(parsed.data) : null;
}

const createBodySchema = z.object({ renderJobId: z.string().uuid() }).strict();
