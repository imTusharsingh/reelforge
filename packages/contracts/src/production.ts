import { z } from "zod";

/**
 * Core-owned read/write contracts for production job discovery and safe scene mutations.
 *
 * These DTOs are additive to the v1 API. They never carry provider secrets, storage keys, or
 * fabricated readiness. Discovery is backed by persisted production rows, not usage ledger lines
 * or workflow result references.
 */

export const SCENE_MEDIA_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
] as const;
export const SceneMediaJobStatusSchema = z.enum(SCENE_MEDIA_JOB_STATUSES);
export type SceneMediaJobStatus = z.infer<typeof SceneMediaJobStatusSchema>;

export const SCENE_MEDIA_KINDS = ["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"] as const;
export const SceneMediaKindSchema = z.enum(SCENE_MEDIA_KINDS);
export type SceneMediaKind = z.infer<typeof SceneMediaKindSchema>;

export const RequestedOutputsSchema = z
  .object({
    image: z.literal(true),
    video: z.boolean().default(false),
    narration: z.boolean().default(false),
    dialogue: z.boolean().default(false),
  })
  .strict();
export type RequestedOutputs = z.infer<typeof RequestedOutputsSchema>;

const PageNumberSchema = z.coerce.number().int().min(1).max(10_000);
const PageSizeSchema = z.coerce.number().int().min(1).max(100);

export const SceneMediaJobSummarySchema = z
  .object({
    jobId: z.uuid(),
    workspaceId: z.uuid(),
    scriptId: z.uuid(),
    scriptRevision: z.number().int().positive(),
    channelId: z.uuid().nullable(),
    status: SceneMediaJobStatusSchema,
    version: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
    configSnapshotId: z.uuid(),
    promptSnapshotId: z.uuid(),
    requestedOutputs: RequestedOutputsSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type SceneMediaJobSummary = z.infer<typeof SceneMediaJobSummarySchema>;

export const SceneMediaJobListQuerySchema = z
  .object({
    scriptId: z.uuid().optional(),
    channelId: z.uuid().optional(),
    status: SceneMediaJobStatusSchema.optional(),
    page: PageNumberSchema.default(1),
    pageSize: PageSizeSchema.default(25),
  })
  .strict();
export type SceneMediaJobListQuery = z.infer<typeof SceneMediaJobListQuerySchema>;

export const SceneMediaJobListSchema = z
  .object({
    items: z.array(SceneMediaJobSummarySchema),
    page: PageNumberSchema,
    pageSize: PageSizeSchema,
    nextPage: PageNumberSchema.nullable(),
  })
  .strict();
export type SceneMediaJobList = z.infer<typeof SceneMediaJobListSchema>;

/**
 * Stable mutation idempotency. The same key must always describe the same operation, target scene,
 * output kind, and observed job version. A different payload under the same key is a conflict.
 */
export const SceneMediaMutationOperationSchema = z.enum([
  "RETRY",
  "REGENERATE",
  "REPLACE",
  "ASSIGN_ASSET",
]);
export type SceneMediaMutationOperation = z.infer<typeof SceneMediaMutationOperationSchema>;

export const SceneMediaJobMutationRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    expectedJobVersion: z.number().int().positive(),
  })
  .strict();
export type SceneMediaJobMutationRequest = z.infer<typeof SceneMediaJobMutationRequestSchema>;

export const ReplaceSceneMediaOutputRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    expectedJobVersion: z.number().int().positive(),
    kind: SceneMediaKindSchema,
  })
  .strict();
export type ReplaceSceneMediaOutputRequest = z.infer<typeof ReplaceSceneMediaOutputRequestSchema>;

export const AssignSceneAssetRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    expectedJobVersion: z.number().int().positive(),
    kind: SceneMediaKindSchema,
    assetId: z.string().uuid(),
    assetVersion: z.number().int().min(1),
  })
  .strict();
export type AssignSceneAssetRequest = z.infer<typeof AssignSceneAssetRequestSchema>;

export const SCENE_MEDIA_CAPABILITY_UNAVAILABLE_REASONS = [
  "PROVIDER_NOT_CONFIGURED",
  "CAPABILITY_NOT_REGISTERED",
  "CAPABILITY_MISMATCH",
  "PROVIDER_ENVIRONMENT_MISMATCH",
  "COST_UNKNOWN",
] as const;
export const SceneMediaCapabilityUnavailableReasonSchema = z.enum(
  SCENE_MEDIA_CAPABILITY_UNAVAILABLE_REASONS,
);
export type SceneMediaCapabilityUnavailableReason = z.infer<
  typeof SceneMediaCapabilityUnavailableReasonSchema
>;

export const SceneMediaCapabilityAvailabilitySchema = z
  .object({
    kind: SceneMediaKindSchema,
    available: z.boolean(),
    reason: SceneMediaCapabilityUnavailableReasonSchema.nullable(),
    message: z.string().min(1),
    /** Present only when the capability is actually registered for this environment. */
    providerId: z.string().min(1).nullable(),
    capabilityId: z.string().min(1).nullable(),
  })
  .strict();
export type SceneMediaCapabilityAvailability = z.infer<
  typeof SceneMediaCapabilityAvailabilitySchema
>;

export const SceneMediaCapabilityCatalogSchema = z
  .object({
    workspaceId: z.uuid(),
    generatedAt: z.iso.datetime(),
    environment: z.enum(["development", "test", "staging", "production"]),
    capabilities: z.array(SceneMediaCapabilityAvailabilitySchema),
  })
  .strict();
export type SceneMediaCapabilityCatalog = z.infer<typeof SceneMediaCapabilityCatalogSchema>;

export const RENDER_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELED",
] as const;
export const RenderJobStatusSchema = z.enum(RENDER_JOB_STATUSES);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const RenderJobSummarySchema = z
  .object({
    jobId: z.uuid(),
    workspaceId: z.uuid(),
    sceneMediaJobId: z.uuid(),
    scriptId: z.uuid(),
    scriptRevision: z.number().int().positive(),
    channelId: z.uuid().nullable(),
    status: RenderJobStatusSchema,
    attempt: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
    inputFingerprint: z.string().min(1),
    parentJobId: z.uuid().nullable(),
    retentionDays: z.number().int().positive(),
    cancelRequestedAt: z.iso.datetime().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    artifactCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiredAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RenderJobSummary = z.infer<typeof RenderJobSummarySchema>;

export const RenderJobListQuerySchema = z
  .object({
    scriptId: z.uuid().optional(),
    channelId: z.uuid().optional(),
    status: RenderJobStatusSchema.optional(),
    page: PageNumberSchema.default(1),
    pageSize: PageSizeSchema.default(25),
  })
  .strict();
export type RenderJobListQuery = z.infer<typeof RenderJobListQuerySchema>;

export const RenderJobListSchema = z
  .object({
    items: z.array(RenderJobSummarySchema),
    page: PageNumberSchema,
    pageSize: PageSizeSchema,
    nextPage: PageNumberSchema.nullable(),
  })
  .strict();
export type RenderJobList = z.infer<typeof RenderJobListSchema>;
