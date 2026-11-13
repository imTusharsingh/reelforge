import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  ProviderError,
  ProviderRegistry,
  type CapabilityMetadata,
  type ImageProviderPort,
  type MediaGenerationResponse,
  type TtsProviderPort,
  type VideoProviderPort,
} from "@reelforge/ai-providers";
import type { AssetService } from "../asset/asset.service.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { sha256Hex } from "../asset/storage/checksum.js";
import { characterSnapshotChecksum } from "../character/character.validation.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { SceneDispatchLedger } from "./scene-media.budget.js";
import { SceneMediaService } from "./scene-media.service.js";
import { providerEnvironment } from "./scene-media.validation.js";
import type { SceneMediaPackage } from "./scene-media.types.js";
import type { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { BudgetExhaustedError } from "../usage-budget/usage-budget.types.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function wavBytes(): Uint8Array {
  const body = Buffer.alloc(12);
  body.write("RIFF", 0, "ascii");
  body.write("WAVE", 8, "ascii");
  return new Uint8Array(body);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done): void => {
    resolve = done;
  });
  return { promise, resolve };
}

function imageResult(request: { correlationId: string }): MediaGenerationResponse {
  return {
    mediaId: `img-${request.correlationId}`,
    providerJobId: `job-${request.correlationId}`,
    providerRequestId: `req-${request.correlationId}`,
    metadata: {
      modelVersion: "fixture-model",
      promptVersion: "fixture-prompt",
      cost: 1,
      currency: "USD",
    },
    media: { declaredMediaType: "image/png", body: PNG },
  };
}

function capability(
  kind: CapabilityMetadata["kind"],
  amount: number | null = 1,
  overrides: Partial<CapabilityMetadata> = {},
): CapabilityMetadata {
  return {
    providerId: "fixture",
    capabilityId: kind,
    kind,
    input: ["text"],
    output: [kind],
    supportsReferenceImages: true,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount },
    ...overrides,
  };
}

function scene(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startSeconds: 0,
    durationSeconds: 1,
    characterRefs: [],
    dialogue: "Hello",
    narration: "Welcome",
    visualDescription: `Visual ${id}`,
    camera: "wide",
    audioCues: [],
    ...patch,
  };
}

function document(scenes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    title: "Title",
    hook: "Hook",
    dialogue: "Dialogue",
    cta: "CTA",
    metadata: { genre: "comedy", targetDurationSeconds: scenes.length, factual: false },
    scenes,
  };
}

type MemoryState = {
  script: {
    id: string;
    workspaceId: string;
    channelId: string | null;
    status: string;
    currentRevision: number;
    revisions: Array<Record<string, unknown>>;
  } | null;
  config: { id: string; workspaceId: string; config: unknown } | null;
  prompt: {
    id: string;
    workspaceId: string;
    configSnapshotId: string;
    bundle: unknown;
    fingerprintSha256: string;
  } | null;
  budget: { id: string; workspaceId: string; channelId: string | null } | null;
  characters: Array<Record<string, unknown>>;
};

class MemoryLedger implements SceneDispatchLedger {
  public readonly reservations: Array<{
    id: string;
    status: string;
    actualCost: number | null;
    chargedCost: number | null;
    correlationId: string;
    estimate: number;
  }> = [];
  public readonly records: Array<{
    correlationId: string;
    status: string;
    actualCost: number | null;
    estimatedCost: number;
  }> = [];

  public async reserve(
    input: Parameters<SceneDispatchLedger["reserve"]>[0],
  ): ReturnType<SceneDispatchLedger["reserve"]> {
    const row = {
      id: randomUUID(),
      budgetId: input.budgetId,
      periodStart: new Date(),
      reservedAmount: input.estimate,
      correlationId: input.correlationId,
      status: "RESERVED",
      actualCost: null,
      chargedCost: null,
      estimate: input.estimate,
    };
    this.reservations.push(row);
    this.records.push({
      correlationId: input.correlationId,
      status: "FAILED",
      actualCost: null,
      estimatedCost: input.estimate,
    });
    return row;
  }

  public async release(
    _workspaceId: string,
    reservation: Parameters<SceneDispatchLedger["release"]>[1],
  ): Promise<void> {
    const row = this.reservations.find((item) => item.id === reservation.id);
    if (row && row.status === "RESERVED") row.status = "RELEASED";
  }

  public async settle(
    _workspaceId: string,
    reservation: Parameters<SceneDispatchLedger["settle"]>[1],
    actualCost: number | null,
    estimate: number,
  ): Promise<void> {
    const row = this.reservations.find((item) => item.id === reservation.id);
    if (!row || row.status !== "RESERVED") {
      throw new ConflictException("Provider reservation could not be settled exactly once");
    }
    row.status = "SETTLED";
    row.actualCost = actualCost;
    row.chargedCost = actualCost ?? estimate;
  }

  public async record(
    _writer: Parameters<SceneDispatchLedger["record"]>[0],
    input: Parameters<SceneDispatchLedger["record"]>[1],
  ): Promise<void> {
    const next = {
      correlationId: input.correlationId,
      status: input.error === undefined ? "SUCCEEDED" : "FAILED",
      actualCost: input.actualCost,
      estimatedCost: input.estimate,
    };
    const existing = this.records.find((item) => item.correlationId === input.correlationId);
    if (existing) Object.assign(existing, next);
    else this.records.push(next);
  }
}

class MemoryStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();
  public async putObject(
    input: Parameters<StoragePort["putObject"]>[0],
  ): ReturnType<StoragePort["putObject"]> {
    const body = Buffer.from(input.body);
    if (body.byteLength === 0) throw new Error("refusing empty object");
    this.objects.set(`${input.workspaceId}/${input.objectKey}`, body);
    return {
      objectKey: input.objectKey,
      byteSize: body.byteLength,
      checksumSha256: sha256Hex(body),
    };
  }
  public async getObject(
    input: Parameters<StoragePort["getObject"]>[0],
  ): ReturnType<StoragePort["getObject"]> {
    const body = this.objects.get(`${input.workspaceId}/${input.objectKey}`);
    if (!body) throw new Error("object missing");
    return Buffer.from(body);
  }
  public async deleteObject(input: Parameters<StoragePort["deleteObject"]>[0]): Promise<void> {
    this.objects.delete(`${input.workspaceId}/${input.objectKey}`);
  }
}

function memoryDatabase(state: MemoryState): {
  db: Database;
  assets: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  mutations: Array<Record<string, unknown>>;
  usages: Array<Record<string, unknown>>;
} {
  const jobs: Array<Record<string, unknown>> = [];
  const generations: Array<Record<string, unknown>> = [];
  const outputs: Array<Record<string, unknown>> = [];
  const assets: Array<Record<string, unknown>> = [];
  const mutations: Array<Record<string, unknown>> = [];
  const usages: Array<Record<string, unknown>> = [];
  const rank: Record<string, number> = { IMAGE: 0, VIDEO: 1, NARRATION: 2, DIALOGUE: 3 };
  const db = {
    script: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { workspaceId_id: { workspaceId: string; id: string } };
        include?: { revisions?: { where?: { revision?: number }; take?: number } };
      }): Promise<unknown> => {
        const script = state.script;
        if (
          !script ||
          script.workspaceId !== where.workspaceId_id.workspaceId ||
          script.id !== where.workspaceId_id.id
        ) {
          return null;
        }
        const revisionFilter = include?.revisions?.where?.revision;
        const revisions = [...script.revisions]
          .filter(
            (revision) => revisionFilter === undefined || revision.revision === revisionFilter,
          )
          .sort((left, right) => Number(right.revision) - Number(left.revision));
        return {
          ...script,
          revisions: revisions.slice(0, include?.revisions?.take ?? revisions.length),
        };
      },
    },
    configSnapshot: {
      findUnique: async (): Promise<unknown> => state.config,
    },
    promptBundleSnapshot: {
      findUnique: async (): Promise<unknown> => state.prompt,
    },
    providerBudget: {
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; channelId: string | null };
      }): Promise<unknown> => {
        if (!state.budget || state.budget.workspaceId !== where.workspaceId) return null;
        if ((state.budget.channelId ?? null) !== (where.channelId ?? null)) return null;
        return { id: state.budget.id };
      },
    },
    characterVersion: {
      findMany: async ({
        where,
      }: {
        where: { workspaceId: string; status: string; id: { in: string[] } };
      }): Promise<unknown> =>
        state.characters.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.status === where.status &&
            where.id.in.includes(String(row.id)),
        ),
    },
    sceneMediaJob: {
      findUnique: async ({
        where,
        include,
      }: {
        where: {
          workspaceId_idempotencyKey?: { workspaceId: string; idempotencyKey: string };
          workspaceId_id?: { workspaceId: string; id: string };
        };
        include?: { scenes?: unknown };
      }): Promise<unknown> => {
        const job = where.workspaceId_idempotencyKey
          ? jobs.find(
              (row) =>
                row.workspaceId === where.workspaceId_idempotencyKey?.workspaceId &&
                row.idempotencyKey === where.workspaceId_idempotencyKey?.idempotencyKey,
            )
          : jobs.find(
              (row) =>
                row.workspaceId === where.workspaceId_id?.workspaceId &&
                row.id === where.workspaceId_id?.id,
            );
        if (!job) return null;
        if (!include?.scenes) return job;
        return {
          ...job,
          scenes: generations
            .filter((row) => row.jobId === job.id && row.activeSlot === 1)
            .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
            .map((row) => ({
              ...row,
              outputs: outputs
                .filter((output) => output.sceneGenerationId === row.id)
                .sort(
                  (left, right) => (rank[String(left.kind)] ?? 0) - (rank[String(right.kind)] ?? 0),
                ),
            })),
        };
      },
      create: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        if (
          jobs.some(
            (row) =>
              row.workspaceId === data.workspaceId && row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: "P2002" };
        }
        const now = new Date();
        const row = {
          id: randomUUID(),
          channelId: data.channelId ?? null,
          version: data.version ?? 1,
          leaseId: data.leaseId ?? null,
          leaseExpiresAt: data.leaseExpiresAt ?? null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        jobs.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { workspaceId_id: { workspaceId: string; id: string } };
        data: Record<string, unknown>;
      }): Promise<unknown> => {
        const row = jobs.find(
          (item) =>
            item.workspaceId === where.workspaceId_id.workspaceId &&
            item.id === where.workspaceId_id.id,
        );
        if (!row) throw new Error("missing job");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          workspaceId: string;
          id: string;
          version?: number;
          leaseId?: string | null;
          leaseExpiresAt?: { gt: Date };
          OR?: Array<{ leaseId: null } | { leaseExpiresAt: { lt: Date } }>;
        };
        data: {
          version?: { increment: number };
          leaseId?: string | null;
          leaseExpiresAt?: Date | null;
          status?: string;
        };
      }): Promise<unknown> => {
        const matched = jobs.filter((row) => {
          if (row.workspaceId !== where.workspaceId || row.id !== where.id) return false;
          if (where.version !== undefined && row.version !== where.version) return false;
          if (where.leaseId !== undefined && row.leaseId !== where.leaseId) {
            return false;
          }
          if (where.leaseExpiresAt) {
            if (
              !(row.leaseExpiresAt instanceof Date) ||
              row.leaseExpiresAt.getTime() <= where.leaseExpiresAt.gt.getTime()
            )
              return false;
          }
          if (where.OR) {
            const matchedClause = where.OR.some((clause) => {
              if ("leaseId" in clause) {
                return row.leaseId === clause.leaseId;
              }
              const expiresAt = row.leaseExpiresAt;
              return (
                expiresAt instanceof Date &&
                expiresAt.getTime() < clause.leaseExpiresAt.lt.getTime()
              );
            });
            if (!matchedClause) return false;
          }
          return true;
        });
        for (const row of matched) {
          if (data.version) {
            row.version = Number(row.version) + data.version.increment;
          }
          if (data.leaseId !== undefined) {
            row.leaseId = data.leaseId;
          }
          if (data.leaseExpiresAt !== undefined) {
            row.leaseExpiresAt = data.leaseExpiresAt;
          }
          if (data.status !== undefined) row.status = data.status;
          row.updatedAt = new Date();
        }
        return { count: matched.length };
      },
      findMany: async ({
        where,
        skip,
        take,
      }: {
        where: {
          workspaceId: string;
          scriptId?: string;
          channelId?: string;
          status?: string;
        };
        skip?: number;
        take?: number;
      }): Promise<unknown> => {
        const matched = jobs
          .filter(
            (row) =>
              row.workspaceId === where.workspaceId &&
              (where.scriptId === undefined || row.scriptId === where.scriptId) &&
              (where.channelId === undefined || row.channelId === where.channelId) &&
              (where.status === undefined || row.status === where.status),
          )
          .sort((left, right) => {
            const byCreated =
              new Date(String(right.createdAt)).getTime() -
              new Date(String(left.createdAt)).getTime();
            return byCreated !== 0 ? byCreated : String(right.id).localeCompare(String(left.id));
          });
        return matched.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take);
      },
    },
    sceneMediaMutation: {
      findUnique: async ({
        where,
      }: {
        where: {
          workspaceId_jobId_idempotencyKey: {
            workspaceId: string;
            jobId: string;
            idempotencyKey: string;
          };
        };
      }): Promise<unknown> =>
        mutations.find(
          (row) =>
            row.workspaceId === where.workspaceId_jobId_idempotencyKey.workspaceId &&
            row.jobId === where.workspaceId_jobId_idempotencyKey.jobId &&
            row.idempotencyKey === where.workspaceId_jobId_idempotencyKey.idempotencyKey,
        ) ?? null,
      create: async ({
        data,
        select,
      }: {
        data: Record<string, unknown>;
        select?: { id?: boolean };
      }): Promise<unknown> => {
        if (
          mutations.some(
            (row) =>
              row.workspaceId === data.workspaceId &&
              row.jobId === data.jobId &&
              row.idempotencyKey === data.idempotencyKey,
          )
        ) {
          throw { code: "P2002" };
        }
        const now = new Date();
        const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
        mutations.push(row);
        return select?.id ? { id: row.id } : row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { workspaceId_id: { workspaceId: string; id: string } };
        data: Record<string, unknown>;
      }): Promise<unknown> => {
        const row = mutations.find(
          (item) =>
            item.workspaceId === where.workspaceId_id.workspaceId &&
            item.id === where.workspaceId_id.id,
        );
        if (!row) throw new Error("missing mutation");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          workspaceId: string;
          id?: string;
          jobId?: string;
          status?: string;
          createdAt?: { lt: Date };
        };
        data: Record<string, unknown>;
      }): Promise<unknown> => {
        const matched = mutations.filter((row) => {
          if (row.workspaceId !== where.workspaceId) return false;
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.jobId !== undefined && row.jobId !== where.jobId) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.createdAt) {
            const createdAt = row.createdAt;
            if (
              !(createdAt instanceof Date) ||
              createdAt.getTime() >= where.createdAt.lt.getTime()
            ) {
              return false;
            }
          }
          return true;
        });
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
        return { count: matched.length };
      },
    },
    sceneGeneration: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_id: { workspaceId: string; id: string } };
      }): Promise<unknown> =>
        generations.find(
          (row) =>
            row.workspaceId === where.workspaceId_id.workspaceId &&
            row.id === where.workspaceId_id.id,
        ) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { workspaceId: string; jobId: string; activeSlot: number; status: string };
      }): Promise<unknown> =>
        generations.find(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.jobId === where.jobId &&
            row.activeSlot === where.activeSlot &&
            row.status === where.status,
        ) ?? null,
      findMany: async ({
        where,
        select,
      }: {
        where: { workspaceId: string; jobId: string; activeSlot: number };
        select?: { status?: boolean };
      }): Promise<unknown> => {
        const rows = generations
          .filter(
            (row) =>
              row.workspaceId === where.workspaceId &&
              row.jobId === where.jobId &&
              row.activeSlot === where.activeSlot,
          )
          .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));
        if (select?.status) return rows.map((row) => ({ status: row.status }));
        return rows.map((row) => ({
          ...row,
          outputs: outputs.filter((output) => output.sceneGenerationId === row.id),
        }));
      },
      create: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        const row = { id: randomUUID(), ...data };
        generations.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { workspaceId_id: { workspaceId: string; id: string } };
        data: Record<string, unknown>;
      }): Promise<unknown> => {
        const row = generations.find(
          (item) =>
            item.workspaceId === where.workspaceId_id.workspaceId &&
            item.id === where.workspaceId_id.id,
        );
        if (!row) throw new Error("missing generation");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { workspaceId: string; jobId: string; sceneId: string; activeSlot: number };
        data: Record<string, unknown>;
      }): Promise<unknown> => {
        const matched = generations.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.jobId === where.jobId &&
            row.sceneId === where.sceneId &&
            row.activeSlot === where.activeSlot,
        );
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
    },
    sceneGenerationOutput: {
      create: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        const row = {
          assetId: null,
          assetVersion: null,
          providerJobId: null,
          providerAssetId: null,
          correlationId: null,
          mediaType: null,
          byteSize: null,
          checksumSha256: null,
          metadata: null,
          errorCode: null,
          errorMessage: null,
          reusedFromOutputId: null,
          ...data,
          id: data.id ?? randomUUID(),
        };
        outputs.push(row);
        return row;
      },
    },
    asset: {
      findFirst: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          version: number;
          OR: Array<{ id?: string; rootAssetId?: string }>;
        };
      }): Promise<unknown> =>
        assets.find(
          (asset) =>
            asset.workspaceId === where.workspaceId &&
            asset.version === where.version &&
            where.OR.some(
              (clause) =>
                clause.id === asset.id ||
                (clause.rootAssetId !== undefined && clause.rootAssetId === asset.rootAssetId),
            ),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        assets.push(data);
        return data;
      },
    },
    assetUsageReference: {
      create: async ({ data }: { data: Record<string, unknown> }): Promise<unknown> => {
        usages.push(data);
        return data;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      callback(db),
  };
  return { db: db as unknown as Database, assets, jobs, mutations, usages };
}

function harness(options?: {
  status?: string;
  scenes?: Record<string, unknown>[];
  image?: Partial<ImageProviderPort> & { capability?: CapabilityMetadata };
  video?: Partial<VideoProviderPort> & { capability?: CapabilityMetadata };
  tts?: Partial<TtsProviderPort> & { capability?: CapabilityMetadata };
  register?: boolean;
  characters?: Array<Record<string, unknown>>;
  cost?: number | null;
  usage?: Pick<UsageBudgetService, "reservePaidCall" | "finishPaidCall">;
  channelId?: string | null;
  currentRevision?: number;
  revisions?: Array<{
    revision: number;
    document: Record<string, unknown>;
    configSnapshotId: string;
    promptSnapshotId: string;
  }>;
}): {
  service: SceneMediaService;
  context: WorkspaceContext;
  ledger: MemoryLedger;
  storage: MemoryStorage;
  assets: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  mutations: Array<Record<string, unknown>>;
  usages: Array<Record<string, unknown>>;
  state: MemoryState;
  imageCalls: Array<{ prompt: string; referenceImageIds?: readonly string[] }>;
  videoCalls: number;
  ttsCalls: string[];
  scriptId: string;
} {
  const workspaceId = randomUUID();
  const scriptId = randomUUID();
  const configId = randomUUID();
  const promptId = randomUUID();
  const imageCalls: Array<{ prompt: string; referenceImageIds?: readonly string[] }> = [];
  const ttsCalls: string[] = [];
  let videoCalls = 0;
  const imageCapability = options?.image?.capability ?? capability("image", options?.cost ?? 1);
  const videoCapability = options?.video?.capability ?? capability("video", options?.cost ?? 1);
  const ttsCapability = options?.tts?.capability ?? capability("tts", options?.cost ?? 1);
  const image: ImageProviderPort = {
    capability: imageCapability,
    generate: async (request) => {
      imageCalls.push({
        prompt: request.prompt,
        ...(request.referenceImageIds ? { referenceImageIds: request.referenceImageIds } : {}),
      });
      if (options?.image?.generate) return options.image.generate(request);
      return {
        mediaId: `img-${request.correlationId}`,
        providerJobId: `job-${request.correlationId}`,
        providerRequestId: `req-${request.correlationId}`,
        metadata: {
          modelVersion: "fixture-model",
          promptVersion: "fixture-prompt",
          cost: options?.cost === undefined ? 1 : options.cost,
          currency: "USD",
        },
        media: { declaredMediaType: "image/png", body: PNG },
      };
    },
  };
  const video: VideoProviderPort = {
    capability: videoCapability,
    generate: async (request) => {
      videoCalls += 1;
      if (options?.video?.generate) return options.video.generate(request);
      throw new Error("video fixture was not expected to run");
    },
  };
  const tts: TtsProviderPort = {
    capability: ttsCapability,
    synthesize: async (request) => {
      ttsCalls.push(request.text);
      if (options?.tts?.synthesize) return options.tts.synthesize(request);
      return {
        mediaId: `aud-${request.correlationId}`,
        providerJobId: `job-${request.correlationId}`,
        providerRequestId: `req-${request.correlationId}`,
        metadata: {
          modelVersion: "fixture-model",
          promptVersion: "fixture-prompt",
          cost: 1,
          currency: "USD",
        },
        media: { declaredMediaType: "audio/wav", body: wavBytes() },
      };
    },
  };
  const registry = new ProviderRegistry();
  if (options?.register !== false) {
    for (const port of [image, video, tts]) {
      registry.register({
        capability: port.capability,
        credential: {
          providerId: port.capability.providerId,
          environment: providerEnvironment(),
          secret: "secret",
        },
      });
    }
  }
  const state: MemoryState = {
    script: {
      id: scriptId,
      workspaceId,
      channelId: options?.channelId ?? null,
      status: options?.status ?? "APPROVED",
      currentRevision: options?.currentRevision ?? 1,
      revisions: options?.revisions ?? [
        {
          revision: 1,
          document: document(options?.scenes ?? [scene("one"), scene("two")]),
          configSnapshotId: configId,
          promptSnapshotId: promptId,
        },
      ],
    },
    config: { id: configId, workspaceId, config: { tone: "warm" } },
    prompt: {
      id: promptId,
      workspaceId,
      configSnapshotId: configId,
      bundle: { renderedText: "Rendered snapshot prompt", fingerprintSha256: "a".repeat(64) },
      fingerprintSha256: "a".repeat(64),
    },
    budget: { id: randomUUID(), workspaceId, channelId: options?.channelId ?? null },
    characters: (options?.characters ?? []).map((row) => ({ workspaceId, ...row })),
  };
  const memory = memoryDatabase(state);
  const ledger = new MemoryLedger();
  const storage = new MemoryStorage();
  const assets = {
    resolveReferences: async (
      _context: WorkspaceContext,
      requests: ReadonlyArray<{ assetId: string; version?: number }>,
    ) =>
      requests.map((request) => ({
        assetId: request.assetId,
        version: request.version ?? 1,
        checksumSha256: "b".repeat(64),
        objectKey: "assets/ref",
        mediaType: "image/png",
        byteSize: PNG.byteLength,
        ownership: "USER_UPLOADED" as const,
        licenseType: "owned",
        licenseTerms: null,
        rightsHolder: "owner",
      })),
  } as unknown as AssetService;
  const service = new SceneMediaService(
    memory.db,
    image,
    video,
    tts,
    registry,
    storage,
    assets,
    ledger,
    options?.usage as UsageBudgetService | undefined,
  );
  return {
    service,
    context: { workspaceId, userId: randomUUID(), role: "OWNER" },
    ledger,
    storage,
    assets: memory.assets,
    jobs: memory.jobs,
    mutations: memory.mutations,
    usages: memory.usages,
    state,
    imageCalls,
    get videoCalls(): number {
      return videoCalls;
    },
    ttsCalls,
    scriptId,
  };
}

const createBody = (
  scriptId: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> => ({
  scriptId,
  expectedScriptRevision: 1,
  idempotencyKey: randomUUID(),
  outputs: { image: true, video: false, narration: false, dialogue: false },
  ...patch,
});

function withVoice(sceneIds: string[]): {
  scenes: Record<string, unknown>[];
  characters: Array<Record<string, unknown>>;
} {
  const characterId = randomUUID();
  const versionId = randomUUID();
  const profile = {
    name: "Nova",
    description: null,
    personality: {},
    voicePreference: { voice: "nova-voice" },
    visualInvariants: {},
    variationRules: {},
  };
  return {
    scenes: sceneIds.map((id) =>
      scene(id, { characterRefs: [{ characterId, versionId }], narration: `Narrate ${id}` }),
    ),
    characters: [
      {
        id: versionId,
        characterId,
        version: 1,
        status: "PUBLISHED",
        profile,
        referenceAssets: [],
        checksumSha256: characterSnapshotChecksum(profile, []),
      },
    ],
  };
}

describe("scene media generation", () => {
  it("rejects viewers before resolving a script or calling a provider", async () => {
    const { service, context, scriptId, imageCalls } = harness();
    await expect(
      service.create({ ...context, role: "VIEWER" }, createBody(scriptId)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(imageCalls).toHaveLength(0);
  });

  it("rejects an unapproved or foreign script before dispatch", async () => {
    const unapproved = harness({ status: "DRAFT" });
    await expect(
      unapproved.service.create(unapproved.context, createBody(unapproved.scriptId)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(unapproved.imageCalls).toHaveLength(0);
    const missing = harness();
    await expect(
      missing.service.create(missing.context, createBody(randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("dispatches configured providers, binds checksums, and reuses the job idempotency key", async () => {
    const env = harness();
    const body = createBody(env.scriptId, { idempotencyKey: "same-job" });
    const created = await env.service.create(env.context, body);
    const again = await env.service.create(env.context, body);
    const exported = await env.service.exportPackage(env.context, created.jobId);
    expect(again.jobId).toBe(created.jobId);
    expect(env.imageCalls).toHaveLength(2);
    expect(created.status).toBe("SUCCEEDED");
    expect(exported.schemaVersion).toBe("1.0");
    expect(exported.scenes).toHaveLength(2);
    expect(exported.scenes[0]?.outputs.every((output) => (output.byteSize ?? 0) > 0)).toBe(true);
    expect(env.assets).toHaveLength(2);
    expect(env.ledger.records.filter((record) => record.status === "SUCCEEDED")).toHaveLength(2);
    expect(env.ledger.reservations.every((row) => row.status === "SETTLED")).toBe(true);
    const checksum = exported.scenes[0]?.outputs[0]?.checksumSha256;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect([...env.storage.objects.values()].some((body) => sha256Hex(body) === checksum)).toBe(
      true,
    );
  });

  it("does not mark empty or placeholder bytes as generated media", async () => {
    const env = harness({
      image: {
        generate: async () => ({
          mediaId: "empty-asset",
          providerJobId: "empty-job",
          metadata: { modelVersion: "m", promptVersion: "p", cost: 1, currency: "USD" },
          media: { declaredMediaType: "image/png", body: new Uint8Array() },
        }),
      },
    });
    const created = (await env.service.create(
      env.context,
      createBody(env.scriptId),
    )) as SceneMediaPackage;
    expect(created.status).not.toBe("SUCCEEDED");
    expect(created.scenes.every((scene) => scene.status !== "SUCCEEDED")).toBe(true);
    expect(env.assets).toHaveLength(0);
    await expect(env.service.exportPackage(env.context, created.jobId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("fails closed for motion when the provider capability is not video", async () => {
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      video: { capability: capability("image") },
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: true, narration: false, dialogue: false },
    });
    expect(env.videoCalls).toBe(0);
    const videoOutput = created.scenes[0]?.outputs.find((output) => output.kind === "VIDEO");
    expect(videoOutput?.status).toBe("FAILED_FINAL");
    expect(videoOutput?.assetId).toBeNull();
    expect(created.scenes[0]?.outputs.find((output) => output.kind === "IMAGE")?.status).toBe(
      "SUCCEEDED",
    );
    await expect(env.service.exportPackage(env.context, created.jobId)).rejects.toThrow(
      /incomplete/i,
    );
  });

  it("retries only the failed scene and reuses the successful scene", async () => {
    let failed = false;
    const voiced = withVoice(["one", "two"]);
    const env = harness({
      scenes: voiced.scenes,
      characters: voiced.characters,
      image: {
        generate: async (request) => {
          if (request.prompt.includes("Scene: two") && !failed) {
            failed = true;
            throw new ProviderError(
              "PROVIDER_UNAVAILABLE",
              "temporary outage",
              request.correlationId,
            );
          }
          return {
            mediaId: `img-${request.correlationId}`,
            providerJobId: `job-${request.correlationId}`,
            metadata: { modelVersion: "m", promptVersion: "p", cost: 1, currency: "USD" },
            media: { declaredMediaType: "image/png", body: PNG },
          };
        },
      },
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: true, dialogue: false },
    });
    const before = env.imageCalls.length;
    const ttsBefore = env.ttsCalls.length;
    const retried = await env.service.retry(env.context, created.jobId, {
      idempotencyKey: randomUUID(),
      expectedJobVersion: created.version,
    });
    const sceneOne = retried.scenes.find((item) => item.sceneId === "one");
    const sceneTwo = retried.scenes.find((item) => item.sceneId === "two");
    expect(sceneOne?.sceneVersion).toBe(1);
    expect(sceneTwo?.sceneVersion).toBe(2);
    expect(sceneTwo?.status).toBe("SUCCEEDED");
    expect(env.imageCalls.filter((call) => call.prompt.includes("Scene: one"))).toHaveLength(1);
    expect(env.imageCalls.filter((call) => call.prompt.includes("Scene: two"))).toHaveLength(2);
    expect(env.imageCalls.length).toBe(before + 1);
    expect(env.ttsCalls).toHaveLength(ttsBefore);
    expect(sceneTwo?.outputs.find((output) => output.kind === "NARRATION")?.status).toBe("REUSED");
  });

  it("regenerates and replaces one scene without restarting the other", async () => {
    const voiced = withVoice(["one", "two"]);
    const env = harness({ scenes: voiced.scenes, characters: voiced.characters });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: true, dialogue: false },
    });
    const regenerated = await env.service.regenerate(env.context, created.jobId, "one", {
      idempotencyKey: randomUUID(),
      expectedJobVersion: created.version,
    });
    expect(regenerated.scenes.find((item) => item.sceneId === "one")?.sceneVersion).toBe(2);
    expect(regenerated.scenes.find((item) => item.sceneId === "two")?.sceneVersion).toBe(1);
    expect(env.imageCalls.filter((call) => call.prompt.includes("Scene: two"))).toHaveLength(1);
    const ttsAfterRegenerate = env.ttsCalls.length;
    const replaced = await env.service.replace(env.context, created.jobId, "two", {
      idempotencyKey: randomUUID(),
      expectedJobVersion: regenerated.version,
      kind: "IMAGE",
    });
    const sceneTwo = replaced.scenes.find((item) => item.sceneId === "two");
    expect(sceneTwo?.sceneVersion).toBe(2);
    expect(sceneTwo?.outputs.find((output) => output.kind === "NARRATION")?.status).toBe("REUSED");
    expect(env.ttsCalls).toHaveLength(ttsAfterRegenerate);
    expect(env.imageCalls.filter((call) => call.prompt.includes("Scene: one"))).toHaveLength(2);
  });

  it("fails closed when narration has no approved voice and does not call TTS", async () => {
    const env = harness({
      scenes: [scene("one", { characterRefs: [], narration: "Speak this", dialogue: "" })],
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: true, dialogue: false },
    });
    expect(env.ttsCalls).toHaveLength(0);
    expect(created.scenes[0]?.outputs.find((output) => output.kind === "NARRATION")).toMatchObject({
      status: "FAILED_FINAL",
      errorCode: "MISSING_VOICE",
      assetId: null,
    });
  });

  it("resolves the owned prompt and character reference package into the provider request", async () => {
    const characterId = randomUUID();
    const versionId = randomUUID();
    const assetId = randomUUID();
    const profile = {
      name: "Nova",
      description: null,
      personality: {},
      voicePreference: { voice: "nova-voice" },
      visualInvariants: {},
      variationRules: {},
    };
    const references = [{ assetId, version: 1 }];
    const env = harness({
      scenes: [
        scene("one", {
          characterRefs: [{ characterId, versionId }],
          narration: "Narrate Nova",
          dialogue: "",
        }),
      ],
      characters: [
        {
          id: versionId,
          characterId,
          version: 2,
          status: "PUBLISHED",
          profile,
          referenceAssets: references,
          checksumSha256: characterSnapshotChecksum(profile, references),
        },
      ],
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: true, dialogue: false },
    });
    expect(created.scenes[0]?.sourceRefs).toMatchObject({
      characters: [
        { characterId, characterVersionId: versionId, checksumSha256: expect.any(String) },
      ],
    });
    expect(env.imageCalls[0]?.prompt).toContain("Rendered snapshot prompt");
    expect(env.imageCalls[0]?.prompt).toContain("Visual one");
    expect(env.imageCalls[0]?.referenceImageIds).toEqual([assetId]);
    expect(env.ttsCalls).toEqual(["Narrate Nova"]);
  });

  it("does not dispatch when the provider estimate is unknown", async () => {
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: { capability: capability("image", null) },
    });
    const image = env;
    const created = await image.service.create(image.context, {
      ...createBody(image.scriptId),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    expect(created.status).toBe("FAILED");
    expect(env.ledger.reservations).toHaveLength(0);
    expect(env.assets).toHaveLength(0);
  });

  it("settles a null actual cost when the provider reports an unknown cost", async () => {
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => ({
          mediaId: `img-${request.correlationId}`,
          providerJobId: `job-${request.correlationId}`,
          metadata: { modelVersion: "m", promptVersion: "p", cost: null, currency: "USD" },
          media: { declaredMediaType: "image/png", body: PNG },
        }),
      },
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    expect(created.status).toBe("SUCCEEDED");
    expect(env.ledger.reservations[0]).toMatchObject({
      status: "SETTLED",
      actualCost: null,
      chargedCost: 1,
    });
    expect(env.ledger.records[0]).toMatchObject({
      status: "SUCCEEDED",
      actualCost: null,
      estimatedCost: 1,
    });
  });

  it("records a failed dispatch and releases the reservation when the provider throws", async () => {
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => {
          throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
        },
      },
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    expect(created.scenes[0]?.outputs[0]?.status).toBe("FAILED_RETRYABLE");
    expect(env.ledger.reservations[0]?.status).toBe("RELEASED");
    expect(env.ledger.records[0]?.status).toBe("FAILED");
    expect(env.assets).toHaveLength(0);
  });

  it("stops before the provider when the M18 budget is exhausted (B1)", async () => {
    const finished: unknown[] = [];
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      usage: {
        reservePaidCall: async (): Promise<never> => {
          throw new BudgetExhaustedError({
            budgetId: randomUUID(),
            period: "DAY",
            limitMinor: 50,
            consumedMinor: 50,
            requestedMinor: 100,
            currency: "USD",
          });
        },
        finishPaidCall: async (...args: unknown[]): Promise<void> => {
          finished.push(args);
        },
      },
    });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    expect(env.imageCalls).toHaveLength(0);
    expect(created.scenes[0]?.outputs[0]).toMatchObject({
      status: "FAILED_RETRYABLE",
      errorCode: "BUDGET_EXHAUSTED",
    });
    // Refused before the M08 hold or ledger row: nothing reserved, nothing recorded.
    expect(env.ledger.reservations).toHaveLength(0);
    expect(env.ledger.records).toHaveLength(0);
    expect(finished).toEqual([[null, { dispatched: false, actualCost: null }]]);
  });

  it("commits the M18 hold after dispatch, including a provider failure (B1)", async () => {
    const hold = { workspaceId: "w", reservationId: "r", currency: "USD", estimateMinor: 100 };
    const finished: unknown[] = [];
    const usage = {
      reservePaidCall: async (): Promise<typeof hold> => hold,
      finishPaidCall: async (...args: unknown[]): Promise<void> => {
        finished.push(args);
      },
    };
    const ok = harness({ scenes: [scene("one", { narration: undefined, dialogue: "" })], usage });
    await ok.service.create(ok.context, createBody(ok.scriptId));
    expect(finished).toEqual([[hold, { dispatched: true, actualCost: 1, actualCurrency: "USD" }]]);
    finished.length = 0;
    const failing = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      usage,
      image: {
        generate: async (request) => {
          throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
        },
      },
    });
    await failing.service.create(failing.context, createBody(failing.scriptId));
    expect(finished).toEqual([[hold, { dispatched: true, actualCost: null }]]);
  });

  it("does not call an unconfigured provider or publish media", async () => {
    const env = harness({
      register: false,
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    expect(env.imageCalls).toHaveLength(0);
    expect(created.status).toBe("FAILED");
    expect(env.assets).toHaveLength(0);
    expect(env.ledger.reservations).toHaveLength(0);
  });

  it.each(["missing", "null", "non-object"] as const)(
    "finalizes a failed settled ledger when metadata is %s",
    async (metadataKind) => {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const env = harness({
        scenes: [scene("one", { narration: undefined, dialogue: "" })],
        image: {
          generate: async (request): Promise<MediaGenerationResponse> => {
            const base = {
              mediaId: `img-${request.correlationId}`,
              providerJobId: `job-${request.correlationId}`,
              providerRequestId: `req-${request.correlationId}`,
              media: { declaredMediaType: "image/png", body: png },
            };
            if (metadataKind === "missing") return base as unknown as MediaGenerationResponse;
            return {
              ...base,
              metadata: metadataKind === "null" ? null : "not-an-object",
            } as unknown as MediaGenerationResponse;
          },
        },
      });
      const created = await env.service.create(env.context, {
        ...createBody(env.scriptId),
        outputs: { image: true, video: false, narration: false, dialogue: false },
      });
      expect(created.status).toBe("FAILED");
      expect(created.scenes[0]?.outputs[0]).toMatchObject({
        status: "FAILED_FINAL",
        assetId: null,
        errorCode: "CONFLICT",
      });
      expect(env.assets).toHaveLength(0);
      expect(env.ledger.reservations[0]).toMatchObject({
        status: "SETTLED",
        actualCost: null,
        chargedCost: 1,
      });
      expect(env.ledger.records[0]).toMatchObject({
        status: "FAILED",
        actualCost: null,
        estimatedCost: 1,
      });
    },
  );

  it("succeeds when provenance omits usage and currency", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => ({
          mediaId: `img-${request.correlationId}`,
          providerJobId: `job-${request.correlationId}`,
          metadata: { modelVersion: "m", promptVersion: "p", cost: 1 },
          media: { declaredMediaType: "image/png", body: png },
        }),
      },
    });
    const created = await env.service.create(env.context, {
      ...createBody(env.scriptId),
      outputs: { image: true, video: false, narration: false, dialogue: false },
    });
    expect(created.status).toBe("SUCCEEDED");
    expect(env.ledger.records[0]).toMatchObject({
      status: "SUCCEEDED",
      actualCost: 1,
      estimatedCost: 1,
    });
    expect(env.ledger.reservations[0]?.status).toBe("SETTLED");
  });

  it("does not hide a ledger finalization failure behind a pending dispatch", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => ({
          mediaId: `img-${request.correlationId}`,
          providerJobId: `job-${request.correlationId}`,
          metadata: { modelVersion: "m", promptVersion: "p", cost: 1 },
          media: { declaredMediaType: "image/png", body: png },
        }),
      },
    });
    const failingLedger = new MemoryLedger();
    failingLedger.record = async (): Promise<void> => {
      throw new Error("ledger write failed");
    };
    const service = new SceneMediaService(
      (env.service as unknown as { db: Database }).db,
      (env.service as unknown as { image: ImageProviderPort }).image,
      (env.service as unknown as { video: VideoProviderPort }).video,
      (env.service as unknown as { tts: TtsProviderPort }).tts,
      (env.service as unknown as { registry: ProviderRegistry }).registry,
      (env.service as unknown as { storage: MemoryStorage }).storage,
      (env.service as unknown as { assets: AssetService }).assets,
      failingLedger,
    );
    await expect(
      service.create(env.context, {
        ...createBody(env.scriptId),
        outputs: { image: true, video: false, narration: false, dialogue: false },
      }),
    ).rejects.toThrow(/could not be finalized/i);
  });

  it("rejects a stale observed script revision before dispatch", async () => {
    const env = harness({ currentRevision: 2 });
    await expect(
      env.service.create(env.context, createBody(env.scriptId, { expectedScriptRevision: 1 })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(env.imageCalls).toHaveLength(0);
    expect(env.jobs).toHaveLength(0);
  });

  it("replays a create key only for the same script revision and outputs", async () => {
    const env = harness();
    const body = createBody(env.scriptId, { idempotencyKey: "pinned-create" });
    const created = await env.service.create(env.context, body);
    await expect(
      env.service.create(env.context, { ...body, expectedScriptRevision: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      env.service.create(env.context, {
        ...body,
        outputs: { image: true, video: true, narration: false, dialogue: false },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(env.jobs).toHaveLength(1);
    expect(created.version).toBe(1);
  });

  it("plans retries from the job's pinned revision and snapshots, not the newer script", async () => {
    const env = harness({ scenes: [scene("one", { narration: undefined, dialogue: "" })] });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    const script = env.state.script;
    if (!script) throw new Error("fixture script missing");
    script.currentRevision = 2;
    script.revisions.push({
      revision: 2,
      document: document([scene("three", { narration: undefined, dialogue: "" })]),
      configSnapshotId: randomUUID(),
      promptSnapshotId: randomUUID(),
    });
    const retried = await env.service.retry(env.context, created.jobId, {
      idempotencyKey: "pinned-retry",
      expectedJobVersion: created.version,
    });
    expect(retried.scriptRevision).toBe(1);
    expect(retried.configSnapshotId).toBe(created.configSnapshotId);
    expect(retried.promptSnapshotId).toBe(created.promptSnapshotId);
    expect(retried.scenes.map((item) => item.sceneId)).toEqual(["one"]);
    expect(env.imageCalls.every((call) => call.prompt.includes("Rendered snapshot prompt"))).toBe(
      true,
    );
  });

  it("refuses to plan a mutation when the pinned revision snapshots no longer match", async () => {
    const env = harness({ scenes: [scene("one", { narration: undefined, dialogue: "" })] });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    const script = env.state.script;
    if (!script) throw new Error("fixture script missing");
    const revision = script.revisions[0];
    if (!revision) throw new Error("fixture revision missing");
    revision.configSnapshotId = randomUUID();
    await expect(
      env.service.retry(env.context, created.jobId, {
        idempotencyKey: "snapshot-drift",
        expectedJobVersion: created.version,
      }),
    ).rejects.toThrow(/immutable configuration and prompt snapshots/i);
    expect(env.imageCalls).toHaveLength(1);
  });

  it("rejects stale job versions and concurrent mutations atomically", async () => {
    let failed = false;
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => {
          if (!failed) {
            failed = true;
            throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
          }
          return {
            mediaId: `img-${request.correlationId}`,
            providerJobId: `job-${request.correlationId}`,
            metadata: { modelVersion: "m", promptVersion: "p", cost: 1, currency: "USD" },
            media: { declaredMediaType: "image/png", body: PNG },
          };
        },
      },
    });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    await expect(
      env.service.retry(env.context, created.jobId, {
        idempotencyKey: "stale-version",
        expectedJobVersion: created.version + 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const callsBefore = env.imageCalls.length;
    const results = await Promise.allSettled([
      env.service.retry(env.context, created.jobId, {
        idempotencyKey: "concurrent-a",
        expectedJobVersion: created.version,
      }),
      env.service.retry(env.context, created.jobId, {
        idempotencyKey: "concurrent-b",
        expectedJobVersion: created.version,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ConflictException);
    expect(env.imageCalls.length).toBe(callsBefore + 1);
    expect(env.mutations).toHaveLength(1);
    const job = env.jobs[0];
    expect(job?.version).toBe(created.version + 1);
  });

  it("replays a completed mutation without dispatching paid work and rejects key reuse", async () => {
    let failed = false;
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => {
          if (!failed) {
            failed = true;
            throw new ProviderError("PROVIDER_UNAVAILABLE", "down", request.correlationId);
          }
          return {
            mediaId: `img-${request.correlationId}`,
            providerJobId: `job-${request.correlationId}`,
            metadata: { modelVersion: "m", promptVersion: "p", cost: 1, currency: "USD" },
            media: { declaredMediaType: "image/png", body: PNG },
          };
        },
      },
    });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    const request = { idempotencyKey: "lost-response", expectedJobVersion: created.version };
    const first = await env.service.retry(env.context, created.jobId, request);
    const callsAfterFirst = env.imageCalls.length;
    const replay = await env.service.retry(env.context, created.jobId, request);
    expect(replay.version).toBe(first.version);
    expect(env.imageCalls).toHaveLength(callsAfterFirst);
    expect(env.mutations).toHaveLength(1);
    await expect(
      env.service.regenerate(env.context, created.jobId, "one", request),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects a different-key mutation while a paid mutation is in flight", async () => {
    let hold = false;
    const entered = deferred();
    const release = deferred();
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => {
          if (hold) {
            entered.resolve();
            await release.promise;
          }
          return imageResult(request);
        },
      },
    });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    hold = true;
    try {
      const first = env.service.regenerate(env.context, created.jobId, "one", {
        idempotencyKey: "in-flight-a",
        expectedJobVersion: created.version,
      });
      await entered.promise;
      const callsWhileHeld = env.imageCalls.length;
      await expect(
        env.service.regenerate(env.context, created.jobId, "one", {
          idempotencyKey: "in-flight-b",
          expectedJobVersion: created.version + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(env.imageCalls).toHaveLength(callsWhileHeld);
      expect(env.mutations).toHaveLength(1);
      release.resolve();
      const result = await first;
      expect(result.version).toBe(created.version + 1);
      expect(env.jobs[0]?.leaseId).toBeNull();
      expect(env.jobs[0]?.leaseExpiresAt).toBeNull();
    } finally {
      hold = false;
      release.resolve();
    }
  });

  it("rejects a mutation while the initial creation dispatch is in flight", async () => {
    const entered = deferred();
    const release = deferred();
    const env = harness({
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
      image: {
        generate: async (request) => {
          entered.resolve();
          await release.promise;
          return imageResult(request);
        },
      },
    });
    const creating = env.service.create(
      env.context,
      createBody(env.scriptId, { idempotencyKey: "create-in-flight" }),
    );
    try {
      await entered.promise;
      const jobId = String(env.jobs[0]?.id);
      const callsWhileHeld = env.imageCalls.length;
      await expect(
        env.service.retry(env.context, jobId, {
          idempotencyKey: "mutation-during-create",
          expectedJobVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(env.imageCalls).toHaveLength(callsWhileHeld);
      expect(env.mutations).toHaveLength(0);
    } finally {
      release.resolve();
    }
    const created = await creating;
    expect(created.status).toBe("SUCCEEDED");
    expect(env.jobs[0]?.leaseId).toBeNull();
    expect(env.jobs[0]?.leaseExpiresAt).toBeNull();
  });

  it("recovers a job whose operation lease expired", async () => {
    const env = harness({ scenes: [scene("one", { narration: undefined, dialogue: "" })] });
    const created = await env.service.create(env.context, createBody(env.scriptId));
    const job = env.jobs[0];
    if (!job) throw new Error("fixture job missing");
    job.leaseId = "crashed-operation";
    job.leaseExpiresAt = new Date(Date.now() - 60_000);
    const staleId = randomUUID();
    const staleAt = new Date(Date.now() - 60 * 60 * 1000);
    env.mutations.push({
      id: staleId,
      workspaceId: env.context.workspaceId,
      jobId: created.jobId,
      operation: "RETRY",
      status: "IN_PROGRESS",
      idempotencyKey: "crashed-key",
      expectedJobVersion: created.version,
      payloadHash: "stale",
      payload: {},
      sceneIds: [],
      sceneVersionBefore: 0,
      sceneVersionAfter: null,
      errorCode: null,
      errorMessage: null,
      createdByUserId: env.context.userId,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    const retried = await env.service.retry(env.context, created.jobId, {
      idempotencyKey: "recover-expired-lease",
      expectedJobVersion: created.version,
    });
    expect(retried.version).toBe(created.version + 1);
    expect(env.mutations.find((row) => row.id === staleId)?.status).toBe("FAILED");
    expect(env.mutations.find((row) => row.id === staleId)?.errorCode).toBe("STALE_OPERATION");
  });

  it("derives capability availability with explicit reasons and no live probe", async () => {
    const unconfigured = harness({
      register: false,
      image: { capability: capability("image", 1, { providerId: "unconfigured" }) },
    });
    const catalog = await unconfigured.service.capabilities(unconfigured.context);
    expect(catalog.capabilities.find((item) => item.kind === "IMAGE")).toMatchObject({
      available: false,
      reason: "PROVIDER_NOT_CONFIGURED",
      providerId: null,
      capabilityId: null,
    });
    expect(catalog.capabilities.find((item) => item.kind === "VIDEO")).toMatchObject({
      available: false,
      reason: "CAPABILITY_NOT_REGISTERED",
    });
    const unknownCost = harness({ image: { capability: capability("image", null) } });
    const costCatalog = await unknownCost.service.capabilities(unknownCost.context);
    expect(costCatalog.capabilities.find((item) => item.kind === "IMAGE")).toMatchObject({
      available: false,
      reason: "COST_UNKNOWN",
    });
    const registered = harness();
    const ready = await registered.service.capabilities(registered.context);
    expect(ready.capabilities.find((item) => item.kind === "IMAGE")).toMatchObject({
      available: true,
      reason: null,
      providerId: "fixture",
      capabilityId: "image",
    });
  });

  it("lists workspace-scoped direct jobs with filters, pagination, and viewer reads", async () => {
    const channelId = randomUUID();
    const env = harness({
      channelId,
      scenes: [scene("one", { narration: undefined, dialogue: "" })],
    });
    const first = await env.service.create(
      env.context,
      createBody(env.scriptId, { idempotencyKey: "list-one" }),
    );
    const second = await env.service.create(
      env.context,
      createBody(env.scriptId, { idempotencyKey: "list-two" }),
    );
    const page = await env.service.list(
      { ...env.context, role: "VIEWER" },
      {
        scriptId: env.scriptId,
        channelId,
        status: "SUCCEEDED",
        page: 1,
        pageSize: 1,
      },
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextPage).toBe(2);
    const last = await env.service.list(env.context, {
      scriptId: env.scriptId,
      channelId,
      status: "SUCCEEDED",
      page: 2,
      pageSize: 1,
    });
    expect(last.items).toHaveLength(1);
    expect([...page.items, ...last.items].map((item) => item.jobId).sort()).toEqual(
      [first.jobId, second.jobId].sort(),
    );
    expect(last.nextPage).toBeNull();
    const foreign = await env.service.list(
      { ...env.context, workspaceId: randomUUID() },
      { page: 1, pageSize: 25 },
    );
    expect(foreign.items).toHaveLength(0);
    const wrongChannel = await env.service.list(env.context, {
      channelId: randomUUID(),
      page: 1,
      pageSize: 25,
    });
    expect(wrongChannel.items).toHaveLength(0);
  });

  it("rejects a character reference whose checksum does not match the published package", async () => {
    const characterId = randomUUID();
    const versionId = randomUUID();
    const profile = {
      name: "Nova",
      description: null,
      personality: {},
      voicePreference: { voice: "nova-voice" },
      visualInvariants: {},
      variationRules: {},
    };
    const env = harness({
      scenes: [scene("one", { characterRefs: [{ characterId, versionId }] })],
      characters: [
        {
          id: versionId,
          characterId,
          version: 1,
          status: "PUBLISHED",
          profile,
          referenceAssets: [],
          checksumSha256: "f".repeat(64),
        },
      ],
    });
    await expect(env.service.create(env.context, createBody(env.scriptId))).rejects.toThrow(
      /checksum/i,
    );
    expect(env.imageCalls).toHaveLength(0);
  });
});

describe("manual scene asset assignment", () => {
  async function setup(): Promise<{
    env: ReturnType<typeof harness>;
    job: SceneMediaPackage;
    request: {
      expectedJobVersion: number;
      idempotencyKey: string;
      kind: string;
      assetId: string;
      assetVersion: number;
    };
  }> {
    const env = harness({ ...withVoice(["one"]), video: {} });
    const job = await env.service.create(
      env.context,
      createBody(env.scriptId, {
        outputs: { image: true, video: false, narration: true, dialogue: true },
      }),
    );
    const assetId = randomUUID();
    env.assets.push({
      id: assetId,
      rootAssetId: assetId,
      workspaceId: env.context.workspaceId,
      version: 1,
      status: "PUBLISHED",
      mediaType: "image/png",
      byteSize: 8,
      checksumSha256: "a".repeat(64),
    });
    const request = {
      expectedJobVersion: job.version,
      idempotencyKey: randomUUID(),
      kind: "IMAGE",
      assetId,
      assetVersion: 1,
    };
    return { env, job, request };
  }
  it.each(["OWNER", "EDITOR"] as const)(
    "assigns for %s, reuses other outputs, exports, records usage and never dispatches",
    async (role) => {
      const { env, job, request } = await setup();
      const before = [
        env.imageCalls.length,
        env.videoCalls,
        env.ttsCalls.length,
        env.ledger.reservations.length,
      ];
      const reserve = vi.fn();
      Object.assign(env.service, { usage: { reservePaidCall: reserve } });
      const result = await env.service.assignAsset(
        { ...env.context, role },
        job.jobId,
        "one",
        request,
      );
      expect(result.scenes[0]?.outputs.find((output) => output.kind === "IMAGE")).toMatchObject({
        status: "ASSIGNED",
        assetId: request.assetId,
      });
      expect(
        result.scenes[0]?.outputs
          .filter((output) => output.kind !== "IMAGE")
          .every((output) => output.status === "REUSED"),
      ).toBe(true);
      expect(env.usages).toContainEqual(
        expect.objectContaining({
          usedByType: "scene_generation_output",
          assetId: request.assetId,
        }),
      );
      expect([
        env.imageCalls.length,
        env.videoCalls,
        env.ttsCalls.length,
        env.ledger.reservations.length,
      ]).toEqual(before);
      expect(reserve).not.toHaveBeenCalled();
      expect(await env.service.exportPackage(env.context, job.jobId)).toMatchObject({
        status: "SUCCEEDED",
      });
      expect(await env.service.assignAsset(env.context, job.jobId, "one", request)).toEqual(result);
      await expect(
        env.service.assignAsset(env.context, job.jobId, "one", {
          ...request,
          assetId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        env.service.assignAsset(env.context, job.jobId, "one", {
          ...request,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );
  it.each([
    ["VIEWER", 403],
    ["FOREIGN", 404],
    ["PENDING", 409],
    ["KIND", 422],
  ])("rejects %s without dispatch", async (scenario, status) => {
    const { env, job, request } = await setup();
    const asset = env.assets.find((row) => row.id === request.assetId)!;
    if (scenario === "FOREIGN") asset.workspaceId = randomUUID();
    if (scenario === "PENDING") asset.status = "PENDING";
    if (scenario === "KIND") asset.mediaType = "audio/wav";
    const before = [
      env.imageCalls.length,
      env.videoCalls,
      env.ttsCalls.length,
      env.ledger.reservations.length,
    ];
    await expect(
      env.service.assignAsset(
        { ...env.context, role: scenario === "VIEWER" ? "VIEWER" : "OWNER" },
        job.jobId,
        "one",
        request,
      ),
    ).rejects.toMatchObject({ status });
    expect([
      env.imageCalls.length,
      env.videoCalls,
      env.ttsCalls.length,
      env.ledger.reservations.length,
    ]).toEqual(before);
  });
});
