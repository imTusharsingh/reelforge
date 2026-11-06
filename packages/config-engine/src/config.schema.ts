import { z } from "zod";

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const PLATFORM_DEFAULTS_VERSION = "m05-platform-v1" as const;

/** Sections of a prompt bundle that no lower configuration layer or user addition may override. */
export const PROTECTED_PROMPT_SECTIONS = ["system", "safety", "rights"] as const;
export type ProtectedPromptSection = (typeof PROTECTED_PROMPT_SECTIONS)[number];

/**
 * Protected policy paths live only in platform defaults. A configuration layer that
 * tries to supply one is rejected before merge, and the resolver also treats these
 * paths as locked for defence in depth.
 */
export const PROTECTED_CONFIG_PATHS = [
  "platformPolicy",
  "safetyPolicy",
  "rightsPolicy",
  "systemPolicy",
] as const;

export const PLATFORM_LOCKED_FIELDS: readonly string[] = [...PROTECTED_CONFIG_PATHS];

export const LockPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)*$/,
    "must be a dot-separated configuration path",
  );

const NonEmptyTextSchema = z.string().trim().min(1).max(200);
const TopicSchema = z.string().trim().min(1).max(120);

export const JsonValueSchema = z.json();

/**
 * Prompt references stored by M03 are opaque JSON. M05 accepts either a bare
 * template ID/key string or an explicit version pin. It never rewrites M03 rows.
 */
export const PromptTemplateReferenceSchema = z
  .union([
    z.string().trim().min(1).max(200),
    z
      .object({
        templateId: z.uuid().optional(),
        templateKey: z.string().trim().min(1).max(120).optional(),
        version: z.number().int().positive().optional(),
      })
      .strict()
      .refine((value) => value.templateId !== undefined || value.templateKey !== undefined, {
        message: "a prompt template reference must provide templateId or templateKey",
      }),
  ])
  .describe("a prompt template ID/key string or an explicit template version reference");

export const StructureSchema = z.record(z.string().min(1), z.json());

export const DurationConfigSchema = z
  .object({
    minSeconds: z.number().int().min(1).max(600),
    maxSeconds: z.number().int().min(1).max(600),
  })
  .strict()
  .refine((value) => value.minSeconds <= value.maxSeconds, {
    message: "duration.minSeconds must be less than or equal to duration.maxSeconds",
    path: ["minSeconds"],
  });

export const DurationOverrideSchema = z
  .object({
    minSeconds: z.number().int().min(1).max(600).optional(),
    maxSeconds: z.number().int().min(1).max(600).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minSeconds === undefined ||
      value.maxSeconds === undefined ||
      value.minSeconds <= value.maxSeconds,
    {
      message: "duration.minSeconds must be less than or equal to duration.maxSeconds",
      path: ["minSeconds"],
    },
  );

export const SafetyProfileSchema = z
  .object({
    level: NonEmptyTextSchema,
    requiresHumanReview: z.boolean(),
  })
  .strict();

export const SafetyProfileOverrideSchema = z
  .object({
    level: NonEmptyTextSchema.optional(),
    requiresHumanReview: z.boolean().optional(),
  })
  .strict();

export const CharacterProfileSchema = z
  .object({
    name: NonEmptyTextSchema,
    description: z.string().max(4000).nullable(),
    personality: z.json(),
    voicePreference: z.json(),
    visualInvariants: z.json(),
    variationRules: z.json(),
  })
  .strict();

export const CharacterRuleSchema = CharacterProfileSchema.extend({
  characterId: z.uuid(),
  characterVersionId: z.uuid(),
  version: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const VideoConfigSchema = z
  .object({
    aspectRatio: NonEmptyTextSchema,
    width: z.number().int().positive().max(8000),
    height: z.number().int().positive().max(8000),
    frameRate: z.number().int().positive().max(120),
  })
  .strict();

export const VideoOverrideSchema = z
  .object({
    aspectRatio: NonEmptyTextSchema.optional(),
    width: z.number().int().positive().max(8000).optional(),
    height: z.number().int().positive().max(8000).optional(),
    frameRate: z.number().int().positive().max(120).optional(),
  })
  .strict();

export const PromptConfigSchema = z
  .object({
    templateRefs: z.array(PromptTemplateReferenceSchema).max(50),
  })
  .strict();

export const PromptOverrideSchema = z
  .object({
    templateRefs: z.array(PromptTemplateReferenceSchema).max(50).optional(),
  })
  .strict();

export const PoliciesSchema = z
  .object({
    goals: z.json().optional(),
    schedule: z.json().optional(),
    automationDefaults: z.json().optional(),
    approvalPolicy: z.json().optional(),
    publishingDestinations: z.json().optional(),
  })
  .strict();

export const IdentitySchema = z
  .object({
    language: NonEmptyTextSchema,
    audience: NonEmptyTextSchema,
    tone: NonEmptyTextSchema,
    niche: NonEmptyTextSchema,
    format: NonEmptyTextSchema,
    frequency: NonEmptyTextSchema,
  })
  .strict();

export const IdentityOverrideSchema = z
  .object({
    language: NonEmptyTextSchema.optional(),
    audience: NonEmptyTextSchema.optional(),
    tone: NonEmptyTextSchema.optional(),
    niche: NonEmptyTextSchema.optional(),
    format: NonEmptyTextSchema.optional(),
    frequency: NonEmptyTextSchema.optional(),
  })
  .strict();

export const TopicsSchema = z
  .object({
    allowed: z.array(TopicSchema).max(200),
    blocked: z.array(TopicSchema).max(200),
  })
  .strict();

export const TopicsOverrideSchema = z
  .object({
    allowed: z.array(TopicSchema).max(200).optional(),
    blocked: z.array(TopicSchema).max(200).optional(),
  })
  .strict();

export const PlatformPolicySchema = z
  .object({
    defaultsVersion: z.literal(PLATFORM_DEFAULTS_VERSION),
    allowUserOverrideOfProtectedSections: z.literal(false),
  })
  .strict();

export const SafetyPolicySchema = z
  .object({
    requiresHumanReview: z.literal(true),
    minimumLevel: z.literal("standard"),
    blockedTopics: z.array(TopicSchema).min(1),
  })
  .strict();

export const RightsPolicySchema = z
  .object({
    requireDocumentedRights: z.literal(true),
    allowUnlicensedMusic: z.literal(false),
    allowedLicenseTypes: z.array(NonEmptyTextSchema).min(1),
  })
  .strict();

export const SystemPolicySchema = z
  .object({
    bundleFormatVersion: z.literal("m05.1"),
    protectedSections: z.tuple([z.literal("system"), z.literal("safety"), z.literal("rights")]),
  })
  .strict();

/**
 * Domain configuration values that any layer below platform defaults may supply.
 * Protected policy fields are deliberately absent; strict parsing rejects them.
 */
export const LayerValuesSchema = z
  .object({
    identity: IdentityOverrideSchema.optional(),
    topics: TopicsOverrideSchema.optional(),
    structure: StructureSchema.optional(),
    duration: DurationOverrideSchema.optional(),
    safetyProfile: SafetyProfileOverrideSchema.optional(),
    characters: z.array(CharacterRuleSchema).max(20).optional(),
    video: VideoOverrideSchema.optional(),
    policies: PoliciesSchema.optional(),
    prompt: PromptOverrideSchema.optional(),
  })
  .strict();

export const CreativeConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    identity: IdentitySchema,
    topics: TopicsSchema,
    structure: StructureSchema,
    duration: DurationConfigSchema,
    safetyProfile: SafetyProfileSchema,
    characters: z.array(CharacterRuleSchema).max(20),
    video: VideoConfigSchema,
    policies: PoliciesSchema,
    prompt: PromptConfigSchema,
    platformPolicy: PlatformPolicySchema,
    safetyPolicy: SafetyPolicySchema,
    rightsPolicy: RightsPolicySchema,
    systemPolicy: SystemPolicySchema,
  })
  .strict();

export const ConfigLayerNameSchema = z.enum([
  "workspace",
  "channel",
  "genre",
  "series",
  "character",
  "video",
]);

export const ConfigLayerSchema = z
  .object({
    name: ConfigLayerNameSchema,
    sourceId: z.string().min(1).max(200),
    sourceRefs: z.array(z.string().min(1).max(200)).max(100).optional(),
    version: z.number().int().positive().optional(),
    values: LayerValuesSchema,
    lockedFields: z.array(LockPathSchema).max(200).default([]),
  })
  .strict();

export type LayerValues = z.infer<typeof LayerValuesSchema>;
export type CreativeConfig = z.infer<typeof CreativeConfigSchema>;
export type ConfigLayerName = z.infer<typeof ConfigLayerNameSchema>;
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>;
export type CharacterRule = z.infer<typeof CharacterRuleSchema>;
export type CharacterProfileConfig = z.infer<typeof CharacterProfileSchema>;
export type PromptTemplateReference = z.infer<typeof PromptTemplateReferenceSchema>;

/** Parses persisted M03 `promptRefs` without rewriting the stored value. */
export function parsePromptTemplateRefs(value: unknown): PromptTemplateReference[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("promptRefs must be an array of template references");
  return value.map((item, index) => {
    const parsed = PromptTemplateReferenceSchema.safeParse(item);
    if (!parsed.success)
      throw new Error(`promptRefs[${index}] is not a valid prompt template reference`);
    return parsed.data;
  });
}

export const platformDefaults: CreativeConfig = CreativeConfigSchema.parse({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  identity: {
    language: "en",
    audience: "General audience",
    tone: "Clear and friendly",
    niche: "general",
    format: "short",
    frequency: "daily",
  },
  topics: {
    allowed: ["education", "how-to"],
    blocked: ["medical advice", "hate"],
  },
  structure: {
    opening: "hook",
    body: "explain",
    closing: "takeaway",
  },
  duration: { minSeconds: 15, maxSeconds: 60 },
  safetyProfile: { level: "standard", requiresHumanReview: true },
  characters: [],
  video: { aspectRatio: "9:16", width: 1080, height: 1920, frameRate: 30 },
  policies: {},
  prompt: { templateRefs: [] },
  platformPolicy: {
    defaultsVersion: PLATFORM_DEFAULTS_VERSION,
    allowUserOverrideOfProtectedSections: false,
  },
  safetyPolicy: {
    requiresHumanReview: true,
    minimumLevel: "standard",
    blockedTopics: ["medical advice", "hate", "graphic violence"],
  },
  rightsPolicy: {
    requireDocumentedRights: true,
    allowUnlicensedMusic: false,
    allowedLicenseTypes: ["CC0-1.0", "CC-BY-4.0", "USER_OWNED"],
  },
  systemPolicy: {
    bundleFormatVersion: "m05.1",
    protectedSections: ["system", "safety", "rights"],
  },
});
