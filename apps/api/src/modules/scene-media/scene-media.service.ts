import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@reelforge/database";
import {
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderError,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
  type ImageProviderPort,
  type ProviderEnvironment,
  type ProviderRegistry,
  type TtsProviderPort,
  type VideoProviderPort,
} from "@reelforge/ai-providers";
import type {
  SceneMediaCapabilityAvailability,
  SceneMediaCapabilityCatalog,
  SceneMediaCapabilityUnavailableReason,
  SceneMediaJobList,
  SceneMediaJobSummary,
  SceneMediaMutationOperation,
} from "@reelforge/contracts";
import { AssetService } from "../asset/asset.service.js";
import { buildAssetObjectKey } from "../asset/asset.validation.js";
import { sha256Hex } from "../asset/storage/checksum.js";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import {
  characterSnapshotChecksum,
  persistedReferenceAssets,
  profileFromJson,
} from "../character/character.validation.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { parseScriptDocument } from "../script/script.validation.js";
import type { ScriptScene } from "../script/script.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import {
  BudgetExhaustedError,
  BudgetUnresolvableError,
  PaidCallNotDispatchedError,
  type PaidCallReservation,
} from "../usage-budget/usage-budget.types.js";
import {
  SCENE_DISPATCH_LEDGER,
  type DispatchReservation,
  type SceneDispatchLedger,
} from "./scene-media.budget.js";
import {
  SCENE_MEDIA_SCHEMA_VERSION,
  type PlannedScene,
  type RequestedOutputs,
  type ResolvedCharacterRef,
  type SceneGenerationStatus,
  type SceneMediaJobStatus,
  type SceneMediaKind,
  type SceneMediaOutput,
  type SceneMediaPackage,
  type SceneOutputStatus,
} from "./scene-media.types.js";
import {
  applicableKinds,
  assertImageCapability,
  assertTtsCapability,
  assertVideoCapability,
  buildScenePrompt,
  isCompletePackage,
  normalizeMediaResult,
  parseCreateInput,
  parseMutationInput,
  parsePromptBundle,
  parseReplaceInput,
  parseSceneMediaJobListQuery,
  providerEnvironment,
  readVoice,
  validateGeneratedMedia,
  type NormalizedMediaResult,
  type NormalizedUsage,
} from "./scene-media.validation.js";

/**
 * Lease for a paid job operation. The exclusion is claimed atomically with the job version, so
 * two create/mutation requests cannot dispatch provider work for the same job at once. A crashed
 * request stops blocking new work after this window; an operation that outlives its lease must
 * tolerate a takeover.
 */
const OPERATION_LEASE_MS = 30 * 60 * 1000;
const OPERATION_HEARTBEAT_MS = 15 * 1000;

type Plan = Readonly<{
  scriptId: string;
  revision: number;
  channelId: string | null;
  configId: string;
  promptId: string;
  budgetId: string;
  scenes: readonly PlannedScene[];
}>;

type PinnedJob = Readonly<{
  id: string;
  scriptId: string;
  scriptRevision: number;
  channelId: string | null;
  version: number;
  requestedOutputs: Prisma.JsonValue;
  configSnapshotId: string;
  promptSnapshotId: string;
}>;

type MutationTarget =
  | Readonly<{ sceneId: null; outputKind: null }>
  | Readonly<{ sceneId: string; outputKind: null }>
  | Readonly<{ sceneId: string; outputKind: SceneMediaKind }>;

type ActiveOutput = {
  id: string;
  kind: SceneMediaKind;
  status: SceneOutputStatus;
  assetId: string | null;
  assetVersion: number | null;
  providerJobId: string | null;
  providerAssetId: string | null;
  mediaType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  metadata: Prisma.JsonValue | null;
};

type ActiveGeneration = {
  id: string;
  sceneId: string;
  sceneVersion: number;
  status: SceneGenerationStatus;
  outputs: ActiveOutput[];
};

type Selection =
  | { readonly type: "initial" }
  | { readonly type: "retry" }
  | { readonly type: "regenerate"; readonly sceneId: string }
  | { readonly type: "replace"; readonly sceneId: string; readonly outputKind: SceneMediaKind };

class MissingVoiceError extends Error {
  public readonly code = "MISSING_VOICE";
  public constructor() {
    super("Approved voice configuration is missing for this scene");
    this.name = "MissingVoiceError";
  }
}

@Injectable()
export class SceneMediaService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(IMAGE_PROVIDER) private readonly image: ImageProviderPort,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProviderPort,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProviderPort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly assets: AssetService,
    @Inject(SCENE_DISPATCH_LEDGER) private readonly ledger: SceneDispatchLedger,
    // M18 budget preflight (B1). Required by Nest DI (SceneMediaModule imports UsageBudgetModule);
    // the parameter is optional only so hand-built unit fixtures without a budget still compile.
    @Inject(UsageBudgetService) private readonly usage?: UsageBudgetService,
  ) {}

  public async create(context: WorkspaceContext, body: unknown): Promise<SceneMediaPackage> {
    this.editor(context);
    const input = parseCreateInput(body);
    const existing = await this.db.sceneMediaJob.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: context.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: {
        id: true,
        scriptId: true,
        scriptRevision: true,
        requestedOutputs: true,
      },
    });
    if (existing) return this.replayCreate(context, existing, input);
    const plan = await this.plan(context, input.scriptId, input.outputs, {
      mode: "create",
      expectedRevision: input.expectedScriptRevision,
    });
    const operationId = randomUUID();
    let jobId: string;
    try {
      const created = await this.db.sceneMediaJob.create({
        data: {
          workspaceId: context.workspaceId,
          scriptId: plan.scriptId,
          scriptRevision: plan.revision,
          channelId: plan.channelId,
          idempotencyKey: input.idempotencyKey,
          schemaVersion: SCENE_MEDIA_SCHEMA_VERSION,
          status: "RUNNING",
          leaseId: operationId,
          leaseExpiresAt: operationExpiry(),
          requestedOutputs: input.outputs,
          configSnapshotId: plan.configId,
          promptSnapshotId: plan.promptId,
          createdByUserId: context.userId,
        },
        select: { id: true },
      });
      jobId = created.id;
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = await this.db.sceneMediaJob.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: context.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: {
          id: true,
          scriptId: true,
          scriptRevision: true,
          requestedOutputs: true,
        },
      });
      if (!raced) throw error;
      return this.replayCreate(context, raced, input);
    }
    try {
      await this.withOperationHeartbeat(context.workspaceId, jobId, operationId, () =>
        this.execute(context, jobId, plan, { type: "initial" }, operationId),
      );
    } finally {
      await this.releaseOperation(context.workspaceId, jobId, operationId);
    }
    return this.present(context, jobId);
  }

  public async get(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
    return this.present(context, jobId);
  }

  /** Workspace-scoped production history, including direct jobs with no usage-ledger rows. */
  public async list(context: WorkspaceContext, query: unknown): Promise<SceneMediaJobList> {
    const parsed = parseSceneMediaJobListQuery(query);
    const rows = await this.db.sceneMediaJob.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(parsed.scriptId === undefined ? {} : { scriptId: parsed.scriptId }),
        ...(parsed.channelId === undefined ? {} : { channelId: parsed.channelId }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize + 1,
      select: {
        id: true,
        workspaceId: true,
        scriptId: true,
        scriptRevision: true,
        channelId: true,
        status: true,
        version: true,
        idempotencyKey: true,
        configSnapshotId: true,
        promptSnapshotId: true,
        requestedOutputs: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const hasNext = rows.length > parsed.pageSize;
    return {
      items: rows.slice(0, parsed.pageSize).map((row) => this.summary(row)),
      page: parsed.page,
      pageSize: parsed.pageSize,
      nextPage: hasNext ? parsed.page + 1 : null,
    };
  }

  /**
   * Server-derived capability availability. This reads registration metadata only; it never
   * performs a provider health probe, exposes credentials, or claims a vendor/model is ready.
   */
  public async capabilities(context: WorkspaceContext): Promise<SceneMediaCapabilityCatalog> {
    const environment = providerEnvironment();
    return {
      workspaceId: context.workspaceId,
      generatedAt: new Date().toISOString(),
      environment,
      capabilities: (["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"] as const).map((kind) =>
        this.capabilityAvailability(kind, environment),
      ),
    };
  }

  public async exportPackage(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
    const pkg = await this.present(context, jobId);
    if (!isCompletePackage(pkg)) {
      throw new ConflictException("Scene media package is incomplete");
    }
    return pkg;
  }

  public async retry(
    context: WorkspaceContext,
    jobId: string,
    body: unknown,
  ): Promise<SceneMediaPackage> {
    this.editor(context);
    const request = parseMutationInput(body);
    return this.mutate(context, jobId, "RETRY", request, {
      sceneId: null,
      outputKind: null,
    });
  }

  public async regenerate(
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    body: unknown,
  ): Promise<SceneMediaPackage> {
    this.editor(context);
    const request = parseMutationInput(body);
    return this.mutate(context, jobId, "REGENERATE", request, {
      sceneId,
      outputKind: null,
    });
  }

  public async replace(
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    body: unknown,
  ): Promise<SceneMediaPackage> {
    this.editor(context);
    const request = parseReplaceInput(body);
    return this.mutate(context, jobId, "REPLACE", request, {
      sceneId,
      outputKind: request.kind,
    });
  }

  public async providerHealth(
    context: WorkspaceContext,
    providerId: string,
    capabilityId: string,
  ): Promise<unknown> {
    this.editor(context);
    return this.registry.healthCheck(providerId, capabilityId);
  }

  private editor(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }

  private async replayCreate(
    context: WorkspaceContext,
    existing: Readonly<{
      id: string;
      scriptId: string;
      scriptRevision: number;
      requestedOutputs: Prisma.JsonValue;
    }>,
    input: Readonly<{
      scriptId: string;
      expectedScriptRevision: number;
      outputs: RequestedOutputs;
    }>,
  ): Promise<SceneMediaPackage> {
    if (
      existing.scriptId !== input.scriptId ||
      existing.scriptRevision !== input.expectedScriptRevision ||
      !sameOutputs(requestedOutputs(existing.requestedOutputs), input.outputs)
    ) {
      throw new ConflictException(
        "The same idempotency key requires the same script revision and requested outputs",
      );
    }
    return this.present(context, existing.id);
  }

  /**
   * Claim exactly one mutation for an observed job version, then execute it from the job's
   * immutable pinned script revision and snapshots. A replay of a completed key returns the
   * current package without dispatching paid work again.
   */
  private async mutate(
    context: WorkspaceContext,
    jobId: string,
    operation: SceneMediaMutationOperation,
    request: Readonly<{ idempotencyKey: string; expectedJobVersion: number }>,
    target: MutationTarget,
  ): Promise<SceneMediaPackage> {
    const job = await this.requireJob(context, jobId);
    const payload = mutationPayload(operation, request.expectedJobVersion, target);
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const existing = await this.db.sceneMediaMutation.findUnique({
      where: {
        workspaceId_jobId_idempotencyKey: {
          workspaceId: context.workspaceId,
          jobId,
          idempotencyKey: request.idempotencyKey,
        },
      },
    });
    if (existing) return this.replayMutation(context, jobId, existing, payloadHash);

    const operationId = randomUUID();
    let mutationId: string;
    try {
      mutationId = await this.db.$transaction(async (tx) => {
        const now = new Date();
        const previousLease = await tx.sceneMediaJob.findUnique({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
          select: { leaseId: true, leaseExpiresAt: true },
        });
        const claimed = await tx.sceneMediaJob.updateMany({
          where: {
            workspaceId: context.workspaceId,
            id: jobId,
            version: request.expectedJobVersion,
            OR: [{ leaseId: null }, { leaseExpiresAt: { lt: now } }],
          },
          data: {
            version: { increment: 1 },
            leaseId: operationId,
            leaseExpiresAt: new Date(now.getTime() + OPERATION_LEASE_MS),
          },
        });
        if (claimed.count !== 1) {
          const current = await tx.sceneMediaJob.findUnique({
            where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
            select: { version: true },
          });
          if (!current) throw new NotFoundException("Scene media job not found");
          if (current.version !== request.expectedJobVersion) {
            throw new ConflictException(
              "The observed scene media job version is stale; reload the job and retry",
            );
          }
          throw new ConflictException(
            "Another scene media operation is already running for this job; wait for it to finish and reload",
          );
        }
        // An expired lease alone does not prove that a submitted provider request stopped.
        // A scene still processing must be reconciled against the provider before more paid work.
        // Rolling back this transaction also rolls back the provisional version/lease claim.
        if (previousLease?.leaseId && previousLease.leaseExpiresAt) {
          const unresolved = await tx.sceneGeneration.findFirst({
            where: {
              workspaceId: context.workspaceId,
              jobId,
              activeSlot: 1,
              status: "PROVIDER_PROCESSING",
            },
            select: { id: true },
          });
          if (unresolved) {
            throw new ConflictException(
              "A previous provider operation may still be running; reconcile its result before another paid attempt",
            );
          }
        }
        // A crashed request releases nothing; reconcile its expired claim so the ledger does not
        // leave a permanent IN_PROGRESS mutation behind.
        await tx.sceneMediaMutation.updateMany({
          where: {
            workspaceId: context.workspaceId,
            jobId,
            status: "IN_PROGRESS",
            createdAt: { lt: new Date(now.getTime() - OPERATION_LEASE_MS) },
          },
          data: {
            status: "FAILED",
            errorCode: "STALE_OPERATION",
            errorMessage: "The operation lease expired before the mutation completed",
          },
        });
        const before = await this.activeGenerations(context.workspaceId, jobId);
        const created = await tx.sceneMediaMutation.create({
          data: {
            workspaceId: context.workspaceId,
            jobId,
            operation,
            status: "IN_PROGRESS",
            idempotencyKey: request.idempotencyKey,
            expectedJobVersion: request.expectedJobVersion,
            payloadHash,
            payload,
            sceneIds: target.sceneId === null ? [] : [target.sceneId],
            sceneVersionBefore: maxSceneVersion(before),
            createdByUserId: context.userId,
          },
          select: { id: true },
        });
        return created.id;
      });
    } catch (error) {
      // A same-key request may have won the unique-key, version, or in-flight race. Reconcile
      // that completed/ongoing claim instead of dispatching a second paid mutation.
      const raced = await this.db.sceneMediaMutation.findUnique({
        where: {
          workspaceId_jobId_idempotencyKey: {
            workspaceId: context.workspaceId,
            jobId,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (raced) return this.replayMutation(context, jobId, raced, payloadHash);
      throw error;
    }

    try {
      await this.withOperationHeartbeat(context.workspaceId, jobId, operationId, async () => {
        const plan = await this.plan(context, job.scriptId, requestedOutputs(job.requestedOutputs), {
          mode: "pinned",
          revision: job.scriptRevision,
          configSnapshotId: job.configSnapshotId,
          promptSnapshotId: job.promptSnapshotId,
        });
        const selection = selectionFor(operation, target);
        await this.execute(context, jobId, plan, selection, operationId);
        const after = await this.activeGenerations(context.workspaceId, jobId);
        await this.db.$transaction(async (tx) => {
          await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
          await tx.sceneMediaMutation.updateMany({
            where: { workspaceId: context.workspaceId, id: mutationId, status: "IN_PROGRESS" },
            data: { status: "SUCCEEDED", sceneVersionAfter: maxSceneVersion(after) },
          });
        });
      });
    } catch (error) {
      await this.db.$transaction(async (tx) => {
        await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
        await tx.sceneMediaMutation.updateMany({
          where: { workspaceId: context.workspaceId, id: mutationId, status: "IN_PROGRESS" },
          data: {
            status: "FAILED",
            errorCode: error instanceof HttpException ? error.name : "MUTATION_FAILED",
            errorMessage: safeMessage(error),
          },
        });
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.releaseOperation(context.workspaceId, jobId, operationId);
    }
    return this.present(context, jobId);
  }

  private async replayMutation(
    context: WorkspaceContext,
    jobId: string,
    existing: Readonly<{ payloadHash: string; status: string }>,
    payloadHash: string,
  ): Promise<SceneMediaPackage> {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictException(
        "The same idempotency key requires the same operation, target, and observed job version",
      );
    }
    if (existing.status === "SUCCEEDED") return this.present(context, jobId);
    if (existing.status === "IN_PROGRESS") {
      throw new ConflictException(
        "This scene media mutation is already in progress; do not retry it",
      );
    }
    throw new ConflictException("This scene media mutation failed; use a new idempotency key");
  }

  private summary(
    row: Readonly<{
      id: string;
      workspaceId: string;
      scriptId: string;
      scriptRevision: number;
      channelId: string | null;
      status: SceneMediaJobStatus;
      version: number;
      idempotencyKey: string;
      configSnapshotId: string;
      promptSnapshotId: string;
      requestedOutputs: Prisma.JsonValue;
      createdAt: Date;
      updatedAt: Date;
    }>,
  ): SceneMediaJobSummary {
    return {
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
      requestedOutputs: requestedOutputs(row.requestedOutputs),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private capabilityAvailability(
    kind: SceneMediaKind,
    environment: ProviderEnvironment,
  ): SceneMediaCapabilityAvailability {
    const capability = this.capabilityFor(kind);
    const expectedProviderKind = providerKind(kind);
    const label = capabilityLabel(kind);
    if (capability.providerId === "unconfigured") {
      return unavailable(kind, "PROVIDER_NOT_CONFIGURED", `${label} is not configured.`);
    }
    if (capability.kind !== expectedProviderKind) {
      return unavailable(
        kind,
        "CAPABILITY_MISMATCH",
        `${label} is bound to a provider capability of the wrong kind.`,
      );
    }
    let registration: ReturnType<ProviderRegistry["get"]>;
    try {
      registration = this.registry.get(capability.providerId, capability.capabilityId);
    } catch (error) {
      if (error instanceof ProviderError && error.code === "CAPABILITY_NOT_REGISTERED") {
        return unavailable(
          kind,
          "CAPABILITY_NOT_REGISTERED",
          `${label} provider capability is not registered for this environment.`,
        );
      }
      throw error;
    }
    if (registration.capability.kind !== expectedProviderKind) {
      return unavailable(
        kind,
        "CAPABILITY_MISMATCH",
        `${label} registered capability does not match this media kind.`,
      );
    }
    if (registration.credential.environment !== environment) {
      return unavailable(
        kind,
        "PROVIDER_ENVIRONMENT_MISMATCH",
        `${label} provider is not configured for this environment.`,
      );
    }
    if (registration.capability.costModel.amount === null) {
      return unavailable(
        kind,
        "COST_UNKNOWN",
        `${label} provider cost is unknown, so budget preflight cannot dispatch it.`,
      );
    }
    return {
      kind,
      available: true,
      reason: null,
      message: `${label} capability is registered for this environment; no live health probe was performed.`,
      providerId: capability.providerId,
      capabilityId: capability.capabilityId,
    };
  }

  private async plan(
    context: WorkspaceContext,
    scriptId: string,
    outputs: RequestedOutputs,
    pin:
      | Readonly<{ mode: "create"; expectedRevision: number }>
      | Readonly<{
          mode: "pinned";
          revision: number;
          configSnapshotId: string;
          promptSnapshotId: string;
        }>,
  ): Promise<Plan> {
    const expectedRevision = pin.mode === "create" ? pin.expectedRevision : pin.revision;
    const script = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: scriptId } },
      include: { revisions: { where: { revision: expectedRevision }, take: 1 } },
    });
    if (!script) throw new NotFoundException("Script not found");
    if (pin.mode === "create") {
      if (script.status !== "APPROVED") {
        throw new ConflictException("Only approved scripts can generate scene media");
      }
      if (script.currentRevision !== expectedRevision) {
        throw new ConflictException(
          "The observed script revision is stale; reload the approved script and retry",
        );
      }
    }
    const revision = script.revisions[0];
    if (!revision || revision.revision !== expectedRevision) {
      throw new ConflictException("The pinned approved script revision is unavailable");
    }
    if (
      pin.mode === "pinned" &&
      (revision.configSnapshotId !== pin.configSnapshotId ||
        revision.promptSnapshotId !== pin.promptSnapshotId)
    ) {
      throw new ConflictException(
        "The pinned script revision no longer matches the job's immutable configuration and prompt snapshots",
      );
    }
    if (!revision.configSnapshotId || !revision.promptSnapshotId) {
      throw new ConflictException(
        "Approved script is missing an owned configuration and prompt snapshot pair",
      );
    }
    const document = parseScriptDocument(revision.document);
    const [config, prompt] = await Promise.all([
      this.db.configSnapshot.findUnique({
        where: {
          workspaceId_id: { workspaceId: context.workspaceId, id: revision.configSnapshotId },
        },
        select: { id: true, config: true },
      }),
      this.db.promptBundleSnapshot.findUnique({
        where: {
          workspaceId_id: { workspaceId: context.workspaceId, id: revision.promptSnapshotId },
        },
        select: { id: true, configSnapshotId: true, bundle: true, fingerprintSha256: true },
      }),
    ]);
    if (!config || !prompt || prompt.configSnapshotId !== config.id) {
      throw new ConflictException(
        "Configuration and prompt snapshots must be an owned, valid pair",
      );
    }
    const bundle = parsePromptBundle(prompt.bundle);
    if (bundle.fingerprintSha256 !== prompt.fingerprintSha256) {
      throw new ConflictException("Prompt snapshot fingerprint does not match its content");
    }
    const budget = await this.db.providerBudget.findFirst({
      where: { workspaceId: context.workspaceId, channelId: script.channelId },
      select: { id: true },
    });
    if (!budget) throw new ConflictException("No workspace provider budget is configured");
    const scenes: PlannedScene[] = [];
    for (const [ordinal, scene] of document.scenes.entries()) {
      const characters = await this.resolveCharacters(context, scene);
      const summary = characters.map((character) => ({
        characterId: character.characterId,
        characterVersionId: character.characterVersionId,
        checksumSha256: character.checksumSha256,
        referenceAssetIds: character.referenceAssetIds,
      }));
      scenes.push({
        scene,
        ordinal,
        characters,
        referenceImageIds: [
          ...new Set(characters.flatMap((character) => character.referenceAssetIds)),
        ],
        kinds: applicableKinds(scene, outputs),
        prompt: buildScenePrompt({
          renderedText: bundle.renderedText,
          config: config.config,
          scene,
          characters: summary,
        }),
        sourceRefs: {
          configSnapshotId: config.id,
          promptSnapshotId: prompt.id,
          promptFingerprint: prompt.fingerprintSha256,
          sceneId: scene.id,
          characters: summary,
        },
      });
    }
    return {
      scriptId: script.id,
      revision: revision.revision,
      channelId: script.channelId,
      configId: config.id,
      promptId: prompt.id,
      budgetId: budget.id,
      scenes,
    };
  }

  private async resolveCharacters(
    context: WorkspaceContext,
    scene: ScriptScene,
  ): Promise<ResolvedCharacterRef[]> {
    if (scene.characterRefs.length === 0) return [];
    const versions = await this.db.characterVersion.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: "PUBLISHED",
        id: { in: scene.characterRefs.map((ref) => ref.versionId) },
      },
    });
    const resolved: ResolvedCharacterRef[] = [];
    for (const ref of scene.characterRefs) {
      const version = versions.find(
        (item) => item.id === ref.versionId && item.characterId === ref.characterId,
      );
      if (!version) {
        throw new ConflictException(
          "Script references an unpublished or foreign character version",
        );
      }
      let profile: ReturnType<typeof profileFromJson>;
      try {
        profile = profileFromJson(version.profile);
      } catch (error) {
        throw new ConflictException(
          error instanceof Error ? error.message : "Character profile is invalid",
        );
      }
      const references = persistedReferenceAssets(version.referenceAssets);
      if (characterSnapshotChecksum(profile, references) !== version.checksumSha256) {
        throw new ConflictException(
          "Character reference package checksum does not match the published version",
        );
      }
      const assets = await this.assets.resolveReferences(context, references);
      resolved.push({
        characterId: version.characterId,
        characterVersionId: version.id,
        version: version.version,
        checksumSha256: version.checksumSha256,
        voicePreference: profile.voicePreference,
        referenceAssetIds: assets
          .filter((asset) => asset.mediaType.startsWith("image/"))
          .map((asset) => asset.assetId),
      });
    }
    return resolved;
  }

  private async execute(
    context: WorkspaceContext,
    jobId: string,
    plan: Plan,
    selection: Selection,
    operationId: string,
  ): Promise<void> {
    await this.requireOperationLease(context.workspaceId, jobId, operationId);
    await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
      await tx.sceneMediaJob.updateMany({
        where: { workspaceId: context.workspaceId, id: jobId, leaseId: operationId },
        data: { status: "RUNNING" },
      });
    });
    try {
      const active = await this.activeGenerations(context.workspaceId, jobId);
      if (selection.type === "replace") {
        const planned = plan.scenes.find((scene) => scene.scene.id === selection.sceneId);
        const previous = active.find((scene) => scene.sceneId === selection.sceneId);
        if (!planned || !previous) throw new NotFoundException("Scene generation not found");
        if (!previous.outputs.some((output) => output.kind === selection.outputKind)) {
          throw new ConflictException("Scene output is not part of this generation");
        }
        const reuse = new Set(
          previous.outputs
            .filter(
              (output) =>
                output.kind !== selection.outputKind &&
                (output.status === "SUCCEEDED" || output.status === "REUSED"),
            )
            .map((output) => output.kind),
        );
        await this.runScene(context, jobId, plan, planned, previous, reuse, operationId);
        return;
      }
      let matched = selection.type !== "regenerate";
      for (const planned of plan.scenes) {
        const previous = active.find((scene) => scene.sceneId === planned.scene.id) ?? null;
        if (selection.type === "retry") {
          if (previous?.status === "SUCCEEDED") continue;
          const reuse = new Set(
            (previous?.outputs ?? [])
              .filter((output) => output.status === "SUCCEEDED" || output.status === "REUSED")
              .map((output) => output.kind),
          );
          await this.runScene(context, jobId, plan, planned, previous, reuse, operationId);
          continue;
        }
        if (selection.type === "regenerate") {
          if (planned.scene.id !== selection.sceneId) continue;
          matched = true;
          await this.runScene(context, jobId, plan, planned, previous, new Set(), operationId);
          continue;
        }
        await this.runScene(context, jobId, plan, planned, null, new Set(), operationId);
      }
      if (!matched) throw new NotFoundException("Scene generation not found");
    } finally {
      await this.refreshJobStatus(context.workspaceId, jobId, operationId);
    }
  }

  private async runScene(
    context: WorkspaceContext,
    jobId: string,
    plan: Plan,
    planned: PlannedScene,
    previous: ActiveGeneration | null,
    reuse: ReadonlySet<SceneMediaKind>,
    operationId: string,
  ): Promise<void> {
    const sceneVersion = (previous?.sceneVersion ?? 0) + 1;
    const generation = await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
      if (previous) {
        await tx.sceneGeneration.updateMany({
          where: {
            workspaceId: context.workspaceId,
            jobId,
            sceneId: planned.scene.id,
            activeSlot: 1,
          },
          data: { activeSlot: null },
        });
      }
      return tx.sceneGeneration.create({
        data: {
          workspaceId: context.workspaceId,
          jobId,
          sceneId: planned.scene.id,
          ordinal: planned.ordinal,
          sceneVersion,
          status: "PROVIDER_PROCESSING",
          idempotencyKey: `${jobId}:${planned.scene.id}:v${sceneVersion}`,
          resolvedPrompt: planned.prompt,
          sourceRefs: planned.sourceRefs as Prisma.InputJsonValue,
          activeSlot: 1,
        },
        select: { id: true, sceneVersion: true },
      });
    });
    const statuses: SceneOutputStatus[] = [];
    for (const kind of planned.kinds) {
      const previousOutput = previous?.outputs.find((output) => output.kind === kind);
      const status =
        previousOutput && reuse.has(kind)
          ? await this.reuseOutput(
              context,
              jobId,
              generation.id,
              generation.sceneVersion,
              planned,
              previousOutput,
              operationId,
            )
          : await this.dispatchOutput(
              context,
              jobId,
              plan,
              planned,
              generation.id,
              generation.sceneVersion,
              kind,
              operationId,
            );
      statuses.push(status);
    }
    await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
      await tx.sceneGeneration.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: generation.id } },
        data: { status: rollupScene(statuses) },
      });
    });
  }

  private async reuseOutput(
    context: WorkspaceContext,
    jobId: string,
    generationId: string,
    sceneVersion: number,
    planned: PlannedScene,
    previous: ActiveOutput,
    operationId: string,
  ): Promise<SceneOutputStatus> {
    if (
      previous.assetId === null ||
      previous.assetVersion === null ||
      previous.byteSize === null ||
      previous.byteSize <= 0 ||
      previous.checksumSha256 === null ||
      previous.providerAssetId === null ||
      previous.mediaType === null
    ) {
      return this.failOutput(context, jobId, operationId, generationId, previous.kind, {
        status: "FAILED_RETRYABLE",
        code: "REUSE_UNAVAILABLE",
        message: "Successful scene output is missing persisted media and cannot be reused",
      });
    }
    const outputId = randomUUID();
    await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
      await tx.sceneGenerationOutput.create({
        data: {
          id: outputId,
          workspaceId: context.workspaceId,
          sceneGenerationId: generationId,
          kind: previous.kind,
          status: "REUSED",
          assetId: previous.assetId,
          assetVersion: previous.assetVersion,
          providerJobId: previous.providerJobId,
          providerAssetId: previous.providerAssetId,
          mediaType: previous.mediaType,
          byteSize: previous.byteSize,
          checksumSha256: previous.checksumSha256,
          metadata: previous.metadata ?? Prisma.JsonNull,
          reusedFromOutputId: previous.id,
        },
      });
      await tx.assetUsageReference.create({
        data: {
          workspaceId: context.workspaceId,
          assetId: previous.assetId as string,
          assetVersion: previous.assetVersion as number,
          usedByType: "scene_generation_output",
          usedById: outputId,
          context: {
            jobId,
            sceneId: planned.scene.id,
            sceneVersion,
            kind: previous.kind,
            checksumSha256: previous.checksumSha256,
            reused: true,
          },
        },
      });
    });
    return "REUSED";
  }

  private async dispatchOutput(
    context: WorkspaceContext,
    jobId: string,
    plan: Plan,
    planned: PlannedScene,
    generationId: string,
    sceneVersion: number,
    kind: SceneMediaKind,
    operationId: string,
  ): Promise<SceneOutputStatus> {
    const correlationId = randomUUID();
    const capability = this.capabilityFor(kind);
    let reservation: DispatchReservation | undefined;
    let settled = false;
    let storedKey: string | undefined;
    const started = Date.now();
    let normalized: NormalizedMediaResult | undefined;
    let usageHold: PaidCallReservation | null = null;
    let dispatched = false;
    let usageFinished = false;
    try {
      await this.requireOperationLease(context.workspaceId, jobId, operationId);
      this.prepareDispatch(kind, planned, capability, correlationId);
      this.registry.assertReady(capability, providerEnvironment());
      const estimate = capability.costModel.amount;
      if (estimate === null) {
        throw new ProviderError(
          "NOT_CONFIGURED",
          "Provider cost is unknown; budget preflight cannot dispatch",
          correlationId,
        );
      }
      // M18 preflight (B1), before the M08 ledger row exists so the call is not counted twice. A
      // hard stop (BUDGET_EXHAUSTED / unresolvable) throws here, the provider is never called, and
      // the output fails with that code; NOT_CONFIGURED (null) proceeds (M16 manual rule).
      usageHold =
        this.usage === undefined
          ? null
          : await this.usage.reservePaidCall({
              workspaceId: context.workspaceId,
              channelId: plan.channelId,
              correlationId,
              category: kind === "IMAGE" || kind === "VIDEO" ? "IMAGE_MEDIA" : "TTS",
              currency: capability.costModel.currency,
              estimate,
            });
      reservation = await this.ledger.reserve({
        workspaceId: context.workspaceId,
        channelId: plan.channelId,
        budgetId: plan.budgetId,
        estimate,
        currency: capability.costModel.currency,
        correlationId,
        dispatchedPrompt: dispatchPrompt(planned, kind),
        providerId: capability.providerId,
        capabilityId: capability.capabilityId,
      });
      await this.requireOperationLease(context.workspaceId, jobId, operationId);
      dispatched = true;
      const raw = await this.invoke(kind, planned, correlationId);
      await this.requireOperationLease(context.workspaceId, jobId, operationId);
      normalized = normalizeMediaResult(raw);
      if (
        !normalized.envelopeValid ||
        normalized.body === null ||
        normalized.declaredMediaType === null
      ) {
        throw new ConflictException("Provider returned an invalid media envelope");
      }
      await this.ledger.settle(
        context.workspaceId,
        reservation,
        normalized.provenanceValid ? normalized.cost : null,
        estimate,
      );
      settled = true;
      usageFinished = true;
      await this.usage?.finishPaidCall(usageHold, {
        dispatched: true,
        actualCost: normalized.provenanceValid ? normalized.cost : null,
        actualCurrency: normalized.provenanceValid ? normalized.currency : null,
      });
      if (!normalized.provenanceValid)
        throw new ConflictException("Provider returned invalid provenance");
      const providerJobId = normalized.providerJobId ?? normalized.providerRequestId;
      if (!providerJobId || normalized.mediaId === null) {
        throw new ConflictException("Provider did not return a job id");
      }
      const providerAssetId = normalized.mediaId;
      const validated = validateGeneratedMedia(kind, normalized.declaredMediaType, normalized.body);
      const assetId = randomUUID();
      const objectKey = buildAssetObjectKey(assetId, 1, validated.mediaType);
      await this.storage.putObject({
        workspaceId: context.workspaceId,
        objectKey,
        body: validated.body,
        contentType: validated.mediaType,
      });
      storedKey = objectKey;
      const read = await this.storage.getObject({
        workspaceId: context.workspaceId,
        objectKey,
      });
      if (read.byteLength !== validated.byteSize || sha256Hex(read) !== validated.checksumSha256) {
        throw new ConflictException("Stored media checksum does not match the generated bytes");
      }
      const outputId = randomUUID();
      const metadata = {
        providerId: capability.providerId,
        capabilityId: capability.capabilityId,
        modelVersion: normalized.modelVersion,
        promptVersion: normalized.promptVersion,
        costKnown: normalized.cost !== null,
      };
      const ledgerInput = this.ledgerInput({
        context,
        correlationId,
        estimate,
        currency: ledgerCurrency(normalized.currency, capability.costModel.currency),
        latencyMs: Date.now() - started,
        dispatchedPrompt: dispatchPrompt(planned, kind),
        normalized,
        actualCost: normalized.cost,
        usage: normalized.usage,
      });
      await this.db.$transaction(async (tx) => {
        await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
        await tx.asset.create({
          data: {
            id: assetId,
            workspaceId: context.workspaceId,
            objectKey,
            mediaType: validated.mediaType,
            filename: validated.filename,
            byteSize: validated.byteSize,
            checksumSha256: validated.checksumSha256,
            version: 1,
            rootAssetId: assetId,
            ownership: "SYSTEM_GENERATED",
            status: "PUBLISHED",
            licenseType: "generated",
            licenseTerms: "System-generated scene media for this workspace",
            rightsHolder: "ReelForge",
            rightsAttestedAt: new Date(),
            createdByUserId: context.userId,
          },
        });
        await this.ledger.record(tx, ledgerInput);
        await tx.sceneGenerationOutput.create({
          data: {
            id: outputId,
            workspaceId: context.workspaceId,
            sceneGenerationId: generationId,
            kind,
            status: "SUCCEEDED",
            assetId,
            assetVersion: 1,
            providerJobId,
            providerAssetId,
            correlationId,
            mediaType: validated.mediaType,
            byteSize: validated.byteSize,
            checksumSha256: validated.checksumSha256,
            metadata,
          },
        });
        await tx.assetUsageReference.create({
          data: {
            workspaceId: context.workspaceId,
            assetId,
            assetVersion: 1,
            usedByType: "scene_generation_output",
            usedById: outputId,
            context: {
              jobId,
              sceneId: planned.scene.id,
              sceneVersion,
              kind,
              checksumSha256: validated.checksumSha256,
            },
          },
        });
      });
      return "SUCCEEDED";
    } catch (error) {
      // Dispatched failures are charged at the estimate; only a never-dispatched call is released.
      if (!usageFinished)
        await this.usage?.finishPaidCall(usageHold, { dispatched, actualCost: null });
      if (reservation && !settled) {
        try {
          await this.ledger.release(context.workspaceId, reservation);
        } catch {
          // A release failure must not skip the terminal ledger write below.
        }
      }
      if (reservation) {
        const estimate = capability.costModel.amount ?? 0;
        await this.finalizeLedger({
          workspaceId: context.workspaceId,
          correlationId,
          estimate,
          currency: ledgerCurrency(normalized?.currency, capability.costModel.currency),
          latencyMs: Date.now() - started,
          dispatchedPrompt: dispatchPrompt(planned, kind),
          responseMetadata: dispatched
            ? responseMetadata(normalized)
            : { dispatched: false, costKnown: false },
          actualCost: normalized?.provenanceValid ? normalized.cost : null,
          usage: normalized?.usage ?? null,
          error,
        });
      }
      if (storedKey) {
        await this.storage
          .deleteObject({ workspaceId: context.workspaceId, objectKey: storedKey })
          .catch(() => undefined);
      }
      const failure = classify(error);
      return this.failOutput(context, jobId, operationId, generationId, kind, failure);
    }
  }

  private async finalizeLedger(input: Parameters<SceneDispatchLedger["record"]>[1]): Promise<void> {
    try {
      await this.ledger.record(this.db, input);
    } catch (first) {
      try {
        await this.ledger.record(this.db, {
          ...input,
          usage: null,
          responseMetadata: {
            dispatched: true,
            costKnown: false,
            providerRequestId: null,
            providerJobId: null,
            providerAssetId: null,
            modelVersion: null,
            promptVersion: null,
          },
          error: input.error ?? first,
        });
      } catch {
        throw new ConflictException("Provider ledger could not be finalized");
      }
    }
  }

  private prepareDispatch(
    kind: SceneMediaKind,
    planned: PlannedScene,
    capability: ImageProviderPort["capability"],
    correlationId: string,
  ): void {
    if (kind === "IMAGE") {
      assertImageCapability(capability, planned.referenceImageIds.length > 0, correlationId);
      return;
    }
    if (kind === "VIDEO") {
      assertVideoCapability(capability, planned.scene.durationSeconds, correlationId);
      return;
    }
    assertTtsCapability(capability, correlationId);
    const lane = kind === "NARRATION" ? "narration" : "dialogue";
    if (!planned.characters.some((character) => readVoice(character.voicePreference, lane))) {
      throw new MissingVoiceError();
    }
  }

  private capabilityFor(kind: SceneMediaKind): ImageProviderPort["capability"] {
    if (kind === "IMAGE") return this.image.capability;
    if (kind === "VIDEO") return this.video.capability;
    return this.tts.capability;
  }

  private async invoke(
    kind: SceneMediaKind,
    planned: PlannedScene,
    correlationId: string,
  ): Promise<unknown> {
    if (kind === "IMAGE") {
      return this.image.generate({
        prompt: planned.prompt,
        referenceImageIds: planned.referenceImageIds,
        correlationId,
      });
    }
    if (kind === "VIDEO") {
      return this.video.generate({
        prompt: planned.prompt,
        durationSeconds: planned.scene.durationSeconds,
        correlationId,
      });
    }
    const lane = kind === "NARRATION" ? "narration" : "dialogue";
    const voice = planned.characters
      .map((character) => readVoice(character.voicePreference, lane))
      .find((value): value is string => value !== undefined);
    if (!voice) throw new MissingVoiceError();
    const text = kind === "NARRATION" ? (planned.scene.narration ?? "") : planned.scene.dialogue;
    return this.tts.synthesize({ text, voice, correlationId });
  }

  private ledgerInput(input: {
    context: WorkspaceContext;
    correlationId: string;
    estimate: number;
    currency: string;
    latencyMs: number;
    dispatchedPrompt: string;
    normalized: NormalizedMediaResult;
    actualCost: number | null;
    usage: NormalizedUsage | null;
    error?: unknown;
  }): Parameters<SceneDispatchLedger["record"]>[1] {
    return {
      workspaceId: input.context.workspaceId,
      correlationId: input.correlationId,
      estimate: input.estimate,
      currency: input.currency,
      latencyMs: input.latencyMs,
      dispatchedPrompt: input.dispatchedPrompt,
      responseMetadata: responseMetadata(input.normalized),
      actualCost: input.actualCost,
      usage: input.usage,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
  }

  private async failOutput(
    context: WorkspaceContext,
    jobId: string,
    operationId: string,
    generationId: string,
    kind: SceneMediaKind,
    failure: { status: "FAILED_RETRYABLE" | "FAILED_FINAL"; code: string; message: string },
  ): Promise<SceneOutputStatus> {
    await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(context.workspaceId, jobId, operationId, tx);
      await tx.sceneGenerationOutput.create({
        data: {
          workspaceId: context.workspaceId,
          sceneGenerationId: generationId,
          kind,
          status: failure.status,
          errorCode: failure.code,
          errorMessage: failure.message,
        },
      });
    });
    return failure.status;
  }

  private async activeGenerations(workspaceId: string, jobId: string): Promise<ActiveGeneration[]> {
    const rows = await this.db.sceneGeneration.findMany({
      where: { workspaceId, jobId, activeSlot: 1 },
      include: { outputs: true },
      orderBy: { ordinal: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      sceneId: row.sceneId,
      sceneVersion: row.sceneVersion,
      status: row.status,
      outputs: row.outputs.map((output) => ({
        id: output.id,
        kind: output.kind,
        status: output.status,
        assetId: output.assetId,
        assetVersion: output.assetVersion,
        providerJobId: output.providerJobId,
        providerAssetId: output.providerAssetId,
        mediaType: output.mediaType,
        byteSize: output.byteSize,
        checksumSha256: output.checksumSha256,
        metadata: output.metadata,
      })),
    }));
  }

  /** Refresh live leases. Ownership checks also fence writes when an operation loses its lease. */
  private async withOperationHeartbeat<T>(
    workspaceId: string,
    jobId: string,
    operationId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    let renewing = false;
    let lost = false;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = true;
      void this.requireOperationLease(workspaceId, jobId, operationId)
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, OPERATION_HEARTBEAT_MS);
    timer.unref();
    try {
      const result = await task();
      if (lost) throw new ConflictException("The scene media operation lease was lost");
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async requireOperationLease(
    workspaceId: string,
    jobId: string,
    operationId: string,
    db: Pick<Database, "sceneMediaJob"> = this.db,
  ): Promise<void> {
    const claimed = await db.sceneMediaJob.updateMany({
      where: {
        workspaceId,
        id: jobId,
        leaseId: operationId,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: operationExpiry() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("The scene media operation lease is no longer owned");
    }
  }

  /**
   * Best-effort release of this request's operation lease. A failure leaves the lease to expire
   * rather than masking the operation result; a takeover already owns the token, so this update
   * cannot clear someone else's claim.
   */
  private async releaseOperation(
    workspaceId: string,
    jobId: string,
    operationId: string,
  ): Promise<void> {
    await this.db.sceneMediaJob
      .updateMany({
        where: {
          workspaceId,
          id: jobId,
          leaseId: operationId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseId: null, leaseExpiresAt: null },
      })
      .catch(() => undefined);
  }

  private async refreshJobStatus(
    workspaceId: string,
    jobId: string,
    operationId: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.requireOperationLease(workspaceId, jobId, operationId, tx);
      const scenes = await tx.sceneGeneration.findMany({
        where: { workspaceId, jobId, activeSlot: 1 },
        select: { status: true },
      });
      await tx.sceneMediaJob.updateMany({
        where: { workspaceId, id: jobId, leaseId: operationId },
        data: { status: rollupJob(scenes.map((scene) => scene.status)) },
      });
    });
  }

  private async requireJob(context: WorkspaceContext, jobId: string): Promise<PinnedJob> {
    const job = await this.db.sceneMediaJob.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: jobId } },
      select: {
        id: true,
        scriptId: true,
        scriptRevision: true,
        channelId: true,
        version: true,
        requestedOutputs: true,
        configSnapshotId: true,
        promptSnapshotId: true,
      },
    });
    if (!job) throw new NotFoundException("Scene media job not found");
    return job;
  }

  private async present(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
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
    const outputs = requestedOutputs(job.requestedOutputs);
    const pkg: SceneMediaPackage = {
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
      requestedOutputs: outputs,
      scenes: job.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        ordinal: scene.ordinal,
        sceneVersion: scene.sceneVersion,
        status: scene.status,
        idempotencyKey: scene.idempotencyKey,
        sourceRefs: scene.sourceRefs,
        outputs: scene.outputs.map((output): SceneMediaOutput => ({
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
    if (job.schemaVersion !== SCENE_MEDIA_SCHEMA_VERSION) {
      throw new ConflictException("Scene media job schema version is not supported");
    }
    return pkg;
  }
}

function requestedOutputs(value: Prisma.JsonValue): RequestedOutputs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConflictException("Scene media job outputs are invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.image !== true) throw new ConflictException("Scene media job outputs are invalid");
  return {
    image: true,
    video: record.video === true,
    narration: record.narration === true,
    dialogue: record.dialogue === true,
  };
}

function rollupScene(statuses: readonly SceneOutputStatus[]): SceneGenerationStatus {
  if (statuses.length === 0) return "FAILED_FINAL";
  if (statuses.every((status) => status === "SUCCEEDED" || status === "REUSED")) return "SUCCEEDED";
  if (statuses.some((status) => status === "FAILED_RETRYABLE" || status === "QUEUED")) {
    return "FAILED_RETRYABLE";
  }
  return "FAILED_FINAL";
}

function rollupJob(statuses: readonly SceneGenerationStatus[]): SceneMediaJobStatus {
  if (statuses.length === 0) return "FAILED";
  if (statuses.every((status) => status === "SUCCEEDED")) return "SUCCEEDED";
  if (statuses.some((status) => status === "SUCCEEDED")) return "PARTIAL";
  return "FAILED";
}

function responseMetadata(normalized: NormalizedMediaResult | undefined): Prisma.InputJsonValue {
  return {
    dispatched: true,
    providerRequestId: normalized?.providerRequestId ?? null,
    providerJobId: normalized?.providerJobId ?? null,
    providerAssetId: normalized?.mediaId ?? null,
    modelVersion: normalized?.modelVersion ?? null,
    promptVersion: normalized?.promptVersion ?? null,
    costKnown: normalized?.provenanceValid === true && typeof normalized.cost === "number",
  };
}

function ledgerCurrency(currency: string | null | undefined, fallback: string): string {
  return typeof currency === "string" && currency.length > 0 ? currency : fallback;
}

function dispatchPrompt(planned: PlannedScene, kind: SceneMediaKind): string {
  if (kind === "NARRATION")
    return `${planned.prompt}\nSpeak narration: ${planned.scene.narration ?? ""}`;
  if (kind === "DIALOGUE") return `${planned.prompt}\nSpeak dialogue: ${planned.scene.dialogue}`;
  if (kind === "VIDEO")
    return `${planned.prompt}\nDuration seconds: ${planned.scene.durationSeconds}`;
  return planned.prompt;
}

function classify(error: unknown): {
  status: "FAILED_RETRYABLE" | "FAILED_FINAL";
  code: string;
  message: string;
} {
  if (error instanceof MissingVoiceError) {
    return { status: "FAILED_FINAL", code: error.code, message: error.message };
  }
  if (
    error instanceof BudgetExhaustedError ||
    error instanceof BudgetUnresolvableError ||
    error instanceof PaidCallNotDispatchedError
  ) {
    // M18 refused the call before dispatch; retry once the period resets or the budget is fixed.
    return { status: "FAILED_RETRYABLE", code: error.code, message: exceptionMessage(error) };
  }
  if (error instanceof ProviderError) {
    return {
      status: error.code === "INVALID_REQUEST" ? "FAILED_FINAL" : "FAILED_RETRYABLE",
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof ConflictException) {
    const budget = error.message.toLowerCase().includes("budget");
    return {
      status: budget ? "FAILED_RETRYABLE" : "FAILED_FINAL",
      code: budget ? "BUDGET_EXCEEDED" : "CONFLICT",
      message: error.message,
    };
  }
  if (error instanceof BadRequestException || error instanceof HttpException) {
    return { status: "FAILED_RETRYABLE", code: "INVALID_MEDIA", message: exceptionMessage(error) };
  }
  return {
    status: "FAILED_RETRYABLE",
    code: error instanceof Error ? error.name : "UNKNOWN",
    message: error instanceof Error ? error.message : "Scene generation failed",
  };
}

function exceptionMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null && "message" in response) {
    const message = (response as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.map((item) => String(item)).join("; ");
  }
  return error.message;
}

function sameOutputs(left: RequestedOutputs, right: RequestedOutputs): boolean {
  return (
    left.image === right.image &&
    left.video === right.video &&
    left.narration === right.narration &&
    left.dialogue === right.dialogue
  );
}

function mutationPayload(
  operation: SceneMediaMutationOperation,
  expectedJobVersion: number,
  target: MutationTarget,
): Prisma.InputJsonValue {
  return {
    operation,
    expectedJobVersion,
    sceneId: target.sceneId,
    outputKind: target.outputKind,
  };
}

function selectionFor(operation: SceneMediaMutationOperation, target: MutationTarget): Selection {
  if (operation === "RETRY") return { type: "retry" };
  if (operation === "REGENERATE") {
    if (target.sceneId === null) {
      throw new BadRequestException("A scene id is required for regeneration");
    }
    return { type: "regenerate", sceneId: target.sceneId };
  }
  if (target.sceneId === null || target.outputKind === null) {
    throw new BadRequestException("A scene id and output kind are required for replacement");
  }
  return { type: "replace", sceneId: target.sceneId, outputKind: target.outputKind };
}

function maxSceneVersion(scenes: readonly Readonly<{ sceneVersion: number }>[]): number {
  return scenes.reduce((max, scene) => Math.max(max, scene.sceneVersion), 0);
}

function unavailable(
  kind: SceneMediaKind,
  reason: SceneMediaCapabilityUnavailableReason,
  message: string,
): SceneMediaCapabilityAvailability {
  return {
    kind,
    available: false,
    reason,
    message,
    providerId: null,
    capabilityId: null,
  };
}

function providerKind(kind: SceneMediaKind): "image" | "video" | "tts" {
  if (kind === "IMAGE") return "image";
  if (kind === "VIDEO") return "video";
  return "tts";
}

function capabilityLabel(kind: SceneMediaKind): string {
  if (kind === "IMAGE") return "Image generation";
  if (kind === "VIDEO") return "Motion generation";
  if (kind === "NARRATION") return "Narration speech generation";
  return "Dialogue speech generation";
}

function operationExpiry(): Date {
  return new Date(Date.now() + OPERATION_LEASE_MS);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : "Scene media mutation failed";
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
