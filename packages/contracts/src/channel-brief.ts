import { z } from "zod";
import { NarratorVoiceSchema } from "./narrator-voice.js";
import { validateBriefDuplicates } from "./brief-consistency.js";
import { ChannelBriefShape, CadenceSchema } from "./foundations.js";

export const BRIEF_FORMATS = [
  "explainer",
  "top-3",
  "story",
  "myth-vs-fact",
  "what-if",
  "history-moment",
  "quick-how-to",
  "news-recap",
] as const;
export const StoredBriefInputShape = ChannelBriefShape.omit({
  id: true,
  workspaceId: true,
  channelId: true,
  version: true,
  schemaVersion: true,
});

/** V7 write DTO. Identity and version are assigned by the server, never by the editor. */
export const BriefInputSchema = StoredBriefInputShape.extend({
  narratorVoice: NarratorVoiceSchema.nullable(),
}).superRefine((brief, ctx) => {
  validateBriefDuplicates(brief, ctx);
  const keys = brief.formatMix.map((item) => item.formatKey);
  if (
    keys.length !== BRIEF_FORMATS.length ||
    BRIEF_FORMATS.some((key) => !keys.includes(key)) ||
    !keys.includes(brief.formatKey)
  )
    ctx.addIssue({ code: "custom", message: "Use the eight built-in formats" });
  if (
    brief.guardrails.blockedPersonaAdvice.length !== 4 ||
    new Set(brief.guardrails.blockedPersonaAdvice).size !== 4
  )
    ctx.addIssue({ code: "custom", message: "All four persona advice guardrails are required" });
});
export type BriefInput = z.infer<typeof BriefInputSchema>;
export const OnboardingInputSchema = z
  .object({
    niche: z.string().trim().min(1).max(200),
    audience: z.string().trim().min(1).max(200),
    language: z.string().trim().min(1).default("English"),
    voiceId: z.string().trim().min(1).default("Kore"),
    cadence: CadenceSchema.default({ shortsPerDay: 1, localTime: "18:00", timezone: "UTC" }),
  })
  .strict();
export type OnboardingInput = z.infer<typeof OnboardingInputSchema>;
// One daily 45-second Short at the primary-route base estimate, plus headroom.
export const defaultBudgetPolicy = {
  currency: "USD",
  targetMinor: 500,
  hardCapMinor: 550,
  dailyLimitMinor: 550,
  monthlyLimitMinor: 16500,
} as const;

export function defaultBrief(input: OnboardingInput): BriefInput {
  const data = OnboardingInputSchema.parse(input);
  return BriefInputSchema.parse({
    topic: data.niche,
    niche: data.niche,
    audience: data.audience,
    languages: { script: data.language, narration: data.language, captions: data.language },
    narrationLanguage: data.language,
    narratorVoice: {
      providerId: "gemini",
      voiceId: data.voiceId,
      language: data.language,
      pace: 1,
    },
    onCameraVoice: null,
    styleBible: {
      visualStyle: "Clear, original educational storytelling",
      palette: [],
      recurringCharacters: [],
      bannedVisuals: [],
    },
    guardrails: {
      bannedTopics: [],
      topicsToAvoid: [],
      blockedPersonaAdvice: ["health", "legal", "finance", "political"],
      allowRealPeople: false,
      allowBrands: false,
      factCheckStrictness: "STRICT",
      aiDisclosure: true,
    },
    formatMix: BRIEF_FORMATS.map((formatKey) => ({ formatKey, weight: 0.125 })),
    tuningBounds: null,
    formatKey: "explainer",
    targetDurationSeconds: 45,
    requestedAutonomy: "L2",
    cadence: data.cadence,
    aiDisclosure: true,
    renderProfile: {
      id: "vertical-1080x1920-24-h264",
      width: 1080,
      height: 1920,
      fps: 24,
      videoCodec: "h264",
    },
    budgetPolicy: defaultBudgetPolicy,
    references: [],
    referenceDefaults: null,
    constraints: {},
  });
}
