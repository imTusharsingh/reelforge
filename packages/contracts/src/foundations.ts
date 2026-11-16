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
  "PLANNING",
  "SCRIPTING",
  "SHOT_PLANNING",
  "GENERATING",
  "ASSEMBLING",
  "CRITIC",
  "AWAITING_APPROVAL",
  "SCHEDULED",
  "PUBLISHED",
  "LEARNING",
  "PAUSED_BUDGET",
  "NEEDS_HUMAN",
  "FAILED",
  "CANCELED",
]);
export type VideoRunState = z.infer<typeof VideoRunStateSchema>;
/** Exact locked Page state diagram. V3 applies these edges with server-side guards. */
export const VIDEO_RUN_TRANSITIONS: Readonly<Record<VideoRunState, readonly VideoRunState[]>> = {
  PLANNING: ["SCRIPTING", "CANCELED"],
  SCRIPTING: ["SHOT_PLANNING"],
  SHOT_PLANNING: ["GENERATING"],
  GENERATING: ["ASSEMBLING", "PAUSED_BUDGET", "FAILED"],
  ASSEMBLING: ["CRITIC"],
  CRITIC: ["AWAITING_APPROVAL", "GENERATING", "NEEDS_HUMAN"],
  AWAITING_APPROVAL: ["SCHEDULED"],
  SCHEDULED: ["PUBLISHED"],
  PUBLISHED: ["LEARNING"],
  LEARNING: [],
  PAUSED_BUDGET: ["GENERATING"],
  NEEDS_HUMAN: ["GENERATING"],
  FAILED: [],
  CANCELED: [],
};
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
    pace: z.number().positive().default(1),
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
const WeightBoundsSchema = z
  .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
  .strict()
  .refine((value) => value.min <= value.max, "Minimum weight exceeds maximum");
export const StyleBibleSchema = z
  .object({
    visualStyle: text,
    palette: z.array(text),
    recurringCharacters: z.array(ReferencePinSchema),
    bannedVisuals: z.array(text),
  })
  .strict();
export const GuardrailsSchema = z
  .object({
    bannedTopics: z.array(text),
    topicsToAvoid: z.array(text),
    blockedPersonaAdvice: z.array(z.enum(["health", "legal", "finance", "political"])),
    allowRealPeople: z.literal(false).default(false),
    allowBrands: z.literal(false).default(false),
    factCheckStrictness: z.enum(["STANDARD", "STRICT"]),
    aiDisclosure: z.literal(true),
  })
  .strict();
export const FormatMixSchema = z
  .array(z.object({ formatKey: text, weight: z.number().min(0).max(1) }).strict())
  .min(1)
  .refine(
    (mix) =>
      new Set(mix.map((item) => item.formatKey)).size === mix.length &&
      Math.abs(mix.reduce((sum, item) => sum + item.weight, 0) - 1) < 0.000001,
    "Format weights must be unique and sum to one",
  );
/** Null means recommendations only. V10 must audit and enforce configured bounds. */
export const TuningBoundsSchema = z
  .object({
    formatMix: z.record(text, WeightBoundsSchema),
    scoringWeights: z.record(text, WeightBoundsSchema),
  })
  .strict();
export const ChannelBriefSchema = owned
  .extend({
    channelId: uuid,
    version: z.int().positive(),
    topic: text,
    niche: text,
    audience: text,
    styleBible: StyleBibleSchema,
    guardrails: GuardrailsSchema,
    formatMix: FormatMixSchema,
    tuningBounds: TuningBoundsSchema.nullable(),
    languages: z.object({ script: text, narration: text, captions: text }).strict(),
    onCameraVoice: NarratorVoiceSchema.nullable(),
    formatKey: text,
    targetDurationSeconds: z.number().positive().max(180),
    narrationLanguage: text,
    narratorVoice: NarratorVoiceSchema.nullable(),
    requestedAutonomy: AutonomyLevelSchema,
    cadence: CadenceSchema,
    aiDisclosure: z.literal(true),
    renderProfile: RenderProfileSchema,
    budgetPolicy: BudgetPolicySchema,
    references: z.array(ReferencePinSchema),
    referenceDefaults: z
      .object({
        character: z.array(ReferencePinSchema),
        style: z.array(ReferencePinSchema),
        scenery: z.array(ReferencePinSchema),
        prop: z.array(ReferencePinSchema),
      })
      .strict()
      .nullable(),
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
    approvedShortsAtStart: z.int().nonnegative(),
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
    costMinor: z.int().nonnegative().nullable(),
    artifacts: z.array(
      z
        .object({
          kind: text,
          assetId: uuid,
          assetVersion: z.int().positive(),
          checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
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
    keyframePrompt: text,
    motionPrompt: text,
    onScreenText: z.string(),
    continuityNotes: z.array(text),
    firstFrameFrom: z
      .union([
        z.object({ previousShotOrdinal: z.int().nonnegative() }).strict(),
        ReferencePinSchema,
      ])
      .nullable(),
    negativePrompt: z.string(),
    durationSeconds: z.number().min(3).max(10),
    voLine: z.string(),
    dialogue: z.string(),
    camera: text,
    transition: text,
    references: z.array(ReferencePinSchema).max(6),
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.int().positive(),
    seed: z.int().nonnegative().nullable(),
  })
  .strict()
  .refine((shot) => shot.width * 16 === shot.height * 9, "Shot dimensions must be 9:16")
  .refine(
    (shot) =>
      !shot.firstFrameFrom ||
      !("previousShotOrdinal" in shot.firstFrameFrom) ||
      shot.firstFrameFrom.previousShotOrdinal < shot.ordinal,
    "First frame must come from an earlier shot",
  );
export type ShotSpec = z.infer<typeof ShotSpecSchema>;
export const ProviderCapabilitySchema = owned
  .extend({
    providerId: text,
    modelId: text,
    kind: z.enum(["TEXT", "IMAGE", "VIDEO", "TTS", "MUSIC"]),
    aspects: z.array(text),
    maxReferenceImages: z.int().nonnegative(),
    firstLastFrame: z.boolean(),
    minExtensionSeconds: z.number().nonnegative(),
    maxExtensionPerTurnSeconds: z.number().nonnegative(),
    maxExtensionSeconds: z.number().nonnegative(),
    nativeAudio: z.boolean(),
    health: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE", "NOT_CONFIGURED"]),
    // Integer micro-USD per second: $0.069504 = 69504, never rounded to cents.
    pricePerSecond: z
      .object({
        "360p": z.int().nonnegative().nullable(),
        "720p": z.int().nonnegative().nullable(),
        "1080p": z.int().nonnegative().nullable(),
      })
      .strict(),
    enabled: z.boolean(),
    supportsReferenceImages: z.boolean(),
    supportsAudio: z.boolean(),
    asynchronous: z.boolean(),
    polling: z.boolean(),
    minDurationSeconds: z.number().nonnegative(),
    maxDurationSeconds: z.number().nonnegative(),
    resolutions: z.array(
      z.object({ width: z.int().positive(), height: z.int().positive() }).strict(),
    ),
    frameRates: z.array(z.int().positive()),
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
    baseEstimateMinor: z.int().nonnegative(),
    reshootReserveMinor: z.int().nonnegative(),
    route: z.enum(["PRIMARY", "FALLBACK"]),
    reservedMinor: z.int().nonnegative(),
    spentMinor: z.int().nonnegative(),
    revision: z.int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.baseEstimateMinor + value.reshootReserveMinor > value.hardCapMinor ||
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
  approvedShorts: number,
): {
  effective: AutonomyLevel;
  offerL3: boolean;
} {
  if (!Number.isSafeInteger(approvedShorts) || approvedShorts < 0)
    throw new Error("Invalid approved count");
  return {
    effective: requested === "L3" && approvedShorts < 10 ? "L2" : requested,
    offerL3: approvedShorts >= 10 && requested !== "L3",
  };
}
