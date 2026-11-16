import { z } from "zod";

export const FOUNDATION_VERSION = "1.0" as const;
const uuid = z.uuid();
const text = z.string().trim().min(1);
const timestamp = z.iso.datetime();
const owned = z.object({
  id: uuid,
  workspaceId: uuid,
  schemaVersion: z.literal(FOUNDATION_VERSION),
});
export const AutonomyLevelSchema = z.enum(["L1", "L2", "L3"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
export const VideoRunStateSchema = z.enum([
  "CREATED",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "PAUSED",
  "PAUSED_BUDGET",
  "NEEDS_HUMAN",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export const VideoRunStepStateSchema = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING_EXTERNAL",
  "WAITING_APPROVAL",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);
export const ReferenceKindSchema = z.enum(["CHARACTER", "STYLE", "SCENERY", "PROP"]);
export const ReferenceSourceSchema = z.enum(["SYSTEM", "PRESET", "UPLOADED", "USER_GENERATED"]);
/** referenceAssetId is the stable ReferenceAsset.referenceId; version selects the immutable row. */
export const ReferencePinSchema = z
  .object({ referenceAssetId: uuid, version: z.int().positive() })
  .strict();
export const NarratorVoiceSchema = z
  .object({
    providerId: text,
    voiceId: text,
    language: text.default("English"),
  })
  .strict();
export const CadenceSchema = z
  .object({
    shortsPerDay: z.int().min(1).max(24),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: text.refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  })
  .strict();
export const RenderProfileSchema = z
  .object({
    id: text,
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.int().positive(),
    videoCodec: z.literal("h264"),
  })
  .strict();
export const BudgetPolicySchema = z
  .object({
    currency: z.literal("USD"),
    targetMinor: z.int().nonnegative(),
    hardCapMinor: z.int().positive(),
    dailyLimitMinor: z.int().positive(),
    monthlyLimitMinor: z.int().positive(),
  })
  .strict()
  .refine((value) => value.targetMinor <= value.hardCapMinor, "target exceeds hard cap");
export const ChannelBriefSchema = owned
  .extend({
    channelId: uuid,
    version: z.int().positive(),
    topic: text,
    audience: text,
    formatKey: text,
    targetDurationSeconds: z.number().positive().max(180),
    narrationLanguage: text,
    narratorVoice: NarratorVoiceSchema.nullable(),
    requestedAutonomy: AutonomyLevelSchema,
    cadence: CadenceSchema,
    aiDisclosure: z.boolean(),
    renderProfile: RenderProfileSchema,
    budgetPolicy: BudgetPolicySchema,
    references: z.array(ReferencePinSchema),
    constraints: z.record(z.string(), z.json()),
  })
  .strict();
export type ChannelBrief = z.infer<typeof ChannelBriefSchema>;
export const VideoRunSchema = owned
  .extend({
    channelId: uuid,
    channelBriefId: uuid,
    channelBriefVersion: z.int().positive(),
    state: VideoRunStateSchema,
    requestedAutonomy: AutonomyLevelSchema,
    effectiveAutonomy: AutonomyLevelSchema,
    idempotencyKey: text,
    correlationId: uuid,
    revision: z.int().nonnegative(),
    inputSnapshot: z.record(z.string(), z.json()),
    publishedShortsAtStart: z.int().nonnegative(),
    criticAgreementScore: z.number().min(0).max(1).nullable(),
    pauseReason: text.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type VideoRun = z.infer<typeof VideoRunSchema>;
export const VideoRunStepSchema = owned
  .extend({
    runId: uuid,
    key: text,
    attempt: z.int().positive(),
    state: VideoRunStepStateSchema,
    idempotencyKey: text,
    providerId: text.nullable(),
    providerJobId: text.nullable(),
    input: z.json(),
    output: z.json(),
    error: z.json(),
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
  })
  .strict();
export type VideoRunStep = z.infer<typeof VideoRunStepSchema>;
export const ShotSpecSchema = owned
  .extend({
    runId: uuid,
    ordinal: z.int().nonnegative(),
    version: z.int().positive(),
    prompt: text,
    negativePrompt: z.string(),
    durationSeconds: z.number().positive().max(180),
    narration: z.string(),
    dialogue: z.string(),
    camera: text,
    transition: text,
    references: z.array(ReferencePinSchema),
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.int().positive(),
    seed: z.int().nonnegative().nullable(),
  })
  .strict();
export type ShotSpec = z.infer<typeof ShotSpecSchema>;
export const ProviderCapabilitySchema = owned
  .extend({
    providerId: text,
    modelId: text,
    kind: z.enum(["TEXT", "IMAGE", "VIDEO", "TTS", "CRITIC"]),
    enabled: z.boolean(),
    supportsReferenceImages: z.boolean(),
    supportsAudio: z.boolean(),
    asynchronous: z.boolean(),
    polling: z.boolean(),
    minDurationSeconds: z.number().nonnegative(),
    maxDurationSeconds: z.number().positive(),
    resolutions: z
      .array(z.object({ width: z.int().positive(), height: z.int().positive() }).strict())
      .min(1),
    frameRates: z.array(z.int().positive()).min(1),
    regions: z.array(text),
    cost: z
      .object({
        currency: z.literal("USD"),
        unit: text,
        estimateMinor: z.int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => value.minDurationSeconds <= value.maxDurationSeconds,
    "invalid duration range",
  );
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
export const RunEventSchema = owned
  .extend({
    runId: uuid,
    stepId: uuid.nullable(),
    sequence: z.int().positive(),
    type: text,
    correlationId: uuid,
    occurredAt: timestamp,
    payload: z.record(z.string(), z.json()),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;
export const BudgetEnvelopeSchema = owned
  .extend({
    runId: uuid,
    currency: z.literal("USD"),
    targetMinor: z.int().nonnegative(),
    hardCapMinor: z.int().positive(),
    reservedMinor: z.int().nonnegative(),
    spentMinor: z.int().nonnegative(),
    revision: z.int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.targetMinor > value.hardCapMinor ||
      value.reservedMinor + value.spentMinor > value.hardCapMinor
    )
      context.addIssue({ code: "custom", message: "Budget exceeds hard cap" });
  });
export type BudgetEnvelope = z.infer<typeof BudgetEnvelopeSchema>;
/** Immutable M04 version, including rights/provenance (ADR-016). No mutable media URL. */
export const ReferenceAssetSchema = owned
  .extend({
    referenceId: uuid,
    kind: ReferenceKindSchema,
    source: ReferenceSourceSchema,
    version: z.int().positive(),
    name: text,
    assetId: uuid.nullable(),
    assetVersion: z.int().positive().nullable(),
    characterVersionId: uuid.nullable(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rights: z.object({ license: text, rightsHolder: text, attestedAt: timestamp }).strict(),
    metadata: z.record(z.string(), z.json()),
    createdAt: timestamp,
  })
  .strict()
  .refine(
    (value) => (value.assetId === null) === (value.assetVersion === null),
    "Asset version must be pinned",
  );
export type ReferenceAsset = z.infer<typeof ReferenceAssetSchema>;
export const ChannelReferenceDefaultsSchema = owned
  .extend({
    channelId: uuid,
    revision: z.int().positive(),
    character: z.array(ReferencePinSchema),
    style: z.array(ReferencePinSchema),
    scenery: z.array(ReferencePinSchema),
    prop: z.array(ReferencePinSchema),
  })
  .strict();
export type ChannelReferenceDefaults = z.infer<typeof ChannelReferenceDefaultsSchema>;

/** First-ten enforcement and L3 eligibility; publishing still checks ADR-005/019 gates. */
export function autonomyPolicy(
  requested: AutonomyLevel,
  publishedShorts: number,
): {
  effective: AutonomyLevel;
  offerL3: boolean;
} {
  if (!Number.isSafeInteger(publishedShorts) || publishedShorts < 0)
    throw new Error("Invalid published count");
  return {
    effective: publishedShorts < 10 ? "L2" : requested,
    offerL3: publishedShorts >= 10 && requested !== "L3",
  };
}
