import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { createRenderSchema } from "../composition/composition.validation.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import { validateGenrePolicy, scriptDocumentSchema } from "../script/script.validation.js";
import type { ScriptDocument } from "../script/script.types.js";
import type {
  HardGateResult,
  QualityRunView,
  QualityRunStatus,
  QualityDecisionAction,
  QualityScorecard,
} from "./quality.types.js";
import {
  approvalPolicySchema,
  hardGateSummarySchema,
  parseApprovalPolicy,
  QUALITY_CRITERIA,
  qualityScorecardSchema,
} from "./quality.validation.js";
import { currentQualityReviewOrder, currentQualityReviewWhere } from "./quality.current-review.js";
const qualityInputSchema = createRenderSchema.shape.input;

@Injectable()
export class QualityService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async get(context: WorkspaceContext, runId: string): Promise<QualityRunView> {
    const run = await this.db.qualityReviewRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: runId } },
      include: { decisions: { orderBy: { createdAt: "asc" } }, regenerationRequests: true },
    });
    if (!run) throw new NotFoundException("Quality review run not found");
    return this.present(run);
  }

  public async assertPublishable(
    context: WorkspaceContext,
    renderJobId: string,
    reviewRunId: string,
  ): Promise<HardGateResult[]> {
    const run = await this.db.qualityReviewRun.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: reviewRunId } },
      include: {
        decisions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
        renderJob: {
          include: {
            sceneMediaJob: { include: { channel: { select: { approvalPolicy: true } } } },
          },
        },
      },
    });
    if (!run || run.renderJobId !== renderJobId)
      throw new ConflictException("The selected quality review does not belong to this render");
    if ((run.status !== "APPROVED" && run.status !== "AUTO_APPROVED") || run.supersededAt !== null)
      throw new ConflictException("The current quality review is not approved for publishing");
    const currentRun = await this.db.qualityReviewRun.findFirst({
      where: currentQualityReviewWhere(context.workspaceId, renderJobId),
      orderBy: currentQualityReviewOrder,
      select: { id: true },
    });
    if (currentRun?.id !== run.id)
      throw new ConflictException("The quality approval is stale; use the current review");
    const parsedGates = hardGateSummarySchema.safeParse(run.gateSummary);
    if (!parsedGates.success)
      throw new InternalServerErrorException("Stored quality gate summary is invalid");
    if (parsedGates.data.some((result) => !result.passed))
      throw new ConflictException("A failed quality hard gate blocks publishing");

    if (run.status === "APPROVED" && run.decisions[0]?.action !== "APPROVE")
      throw new ConflictException("A current human approval decision is required to publish");
    if (run.status === "AUTO_APPROVED") {
      const currentPolicy = parseApprovalPolicy(
        run.renderJob.sceneMediaJob.channel?.approvalPolicy,
      );
      const scorecard = qualityScorecardSchema.safeParse(run.scorecard);
      if (
        currentPolicy.mode !== "AUTO" ||
        !scorecard.success ||
        scorecard.data.score < currentPolicy.scoreThreshold ||
        QUALITY_CRITERIA.some(
          (criterion) =>
            currentPolicy.criterionThresholds[criterion] !== undefined &&
            scorecard.data.criteria[criterion].score <
              (currentPolicy.criterionThresholds[criterion] ?? 0),
        )
      )
        throw new ConflictException(
          "Current channel approval policy no longer permits this auto-approval",
        );
    }

    await this.db.$transaction((tx) =>
      this.assertCurrentApprovalGates(tx, context.workspaceId, run),
    );
    return parsedGates.data;
  }

  private async assertCurrentApprovalGates(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    run: {
      renderJobId: string;
      renderJob: {
        input: Prisma.JsonValue;
        sceneMediaJob: { id: string; scriptId: string; scriptRevision: number };
      };
    },
  ): Promise<void> {
    const parsedInput = qualityInputSchema.safeParse(run.renderJob.input);
    if (!parsedInput.success)
      throw new ConflictException("Current render input no longer passes quality validation");
    const input = parsedInput.data;
    const sceneMediaJob = run.renderJob.sceneMediaJob;
    const scriptRevision = await tx.scriptRevision.findUnique({
      where: {
        workspaceId_scriptId_revision: {
          workspaceId,
          scriptId: sceneMediaJob.scriptId,
          revision: sceneMediaJob.scriptRevision,
        },
      },
      include: { script: { include: { snapshot: { select: { references: true } } } } },
    });
    if (scriptRevision === null)
      throw new ConflictException("Current script provenance no longer passes quality validation");
    const script = parseScriptDocument(scriptRevision.document);
    if (
      !script ||
      input.sourceMediaPackage.jobId !== sceneMediaJob.id ||
      input.sourceMediaPackage.scriptId !== sceneMediaJob.scriptId ||
      input.sourceMediaPackage.scriptRevision !== sceneMediaJob.scriptRevision
    )
      throw new ConflictException("Current script provenance no longer passes quality validation");

    const genre = await tx.genre.findFirst({
      where: { workspaceId, name: script.metadata.genre },
      select: {
        name: true,
        topicsAllowed: true,
        topicsBlocked: true,
        safetyProfile: true,
      },
    });
    const allowedTopics = genre ? stringArray(genre.topicsAllowed) : null;
    const blockedTopics = genre ? stringArray(genre.topicsBlocked) : null;
    if (!genre || !allowedTopics || !blockedTopics)
      throw new ConflictException("Current genre policy no longer passes quality validation");
    const searchableText = normalizePolicyText(
      [
        scriptText(script),
        input.title,
        ...input.scenes.flatMap((scene) => scene.captions.map((caption) => caption.text)),
      ].join("\n"),
    );
    if (blockedTopics.some((term) => searchableText.includes(normalizePolicyText(term))))
      throw new ConflictException("Current script violates the workspace's blocked-topic policy");
    try {
      validateGenrePolicy(
        script,
        { safetyProfile: genre.safetyProfile },
        scriptRevision.script.snapshot.references,
      );
    } catch (error) {
      if (error instanceof ConflictException)
        throw new ConflictException("Current script no longer passes the genre policy gate");
      throw error;
    }

    const assetPairs = collectAssetPairs(input);
    const assetIds = [...new Set(assetPairs.map((asset) => asset.assetId))];
    const assets = assetIds.length
      ? await tx.asset.findMany({
          where: { workspaceId, id: { in: assetIds } },
          select: {
            id: true,
            version: true,
            status: true,
            licenseType: true,
            licenseTerms: true,
            rightsHolder: true,
            rightsAttestedAt: true,
          },
        })
      : [];
    const usageReferences = assetIds.length
      ? await tx.assetUsageReference.findMany({
          where: {
            workspaceId,
            usedByType: "render_input",
            usedById: run.renderJobId,
            assetId: { in: assetIds },
          },
          select: { assetId: true, assetVersion: true },
        })
      : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const usedPairs = new Set(usageReferences.map((reference) => assetPairKey(reference)));
    const rightsPass =
      assetPairs.length > 0 &&
      assetPairs.every((expected) => {
        const asset = assetById.get(expected.assetId);
        return (
          asset !== undefined &&
          asset.version === expected.assetVersion &&
          asset.status === "PUBLISHED" &&
          Boolean(
            asset.licenseType?.trim() &&
            asset.licenseTerms?.trim() &&
            asset.rightsHolder?.trim() &&
            asset.rightsAttestedAt !== null,
          ) &&
          usedPairs.has(assetPairKey(expected))
        );
      });
    if (!rightsPass)
      throw new ConflictException("Current asset rights or provenance no longer pass validation");
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
    supersededAt: Date | null;
    decisions: Array<{
      id: string;
      action: QualityDecisionAction;
      reason: string;
      overrideReason: string | null;
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
        overrideReason: decision.overrideReason,
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
      supersededAt: run.supersededAt?.toISOString() ?? null,
    };
  }
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
    ...input.coverFrames.map((cover) => ({
      assetId: cover.assetId,
      assetVersion: cover.assetVersion,
    })),
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
