import { assertCaptionDuration } from "./caption-readability.js";
import { z } from "zod";
import { HookSchema, CtaSchema, scriptWordBudget, words } from "./script-content.js";
import { StoredChannelBriefSchema, ReferencePinSchema, ShotSpecSchema } from "./foundations.js";

const text = z.string().trim().min(1);
export const PlanningFormatSchema = z.enum([
  "explainer",
  "top-3",
  "story",
  "myth-vs-fact",
  "what-if",
  "history-moment",
  "quick-how-to",
  "news-recap",
]);
export const PLANNING_HOOK_MAX_WORDS = 10;
export const StoredPlanningScriptSchema = z
  .object({
    hook: HookSchema,
    beats: z.array(text).min(3).max(5),
    payoff: text,
    cta: CtaSchema,
    language: text,
    wordCount: z.int().positive(),
  })
  .strict();
export const PlanningScriptSchema = StoredPlanningScriptSchema.extend({
  hook: z
    .string()
    .trim()
    .min(1)
    .refine(
      (hook) => words(hook) <= PLANNING_HOOK_MAX_WORDS,
      `Hook must contain at most ${PLANNING_HOOK_MAX_WORDS} words`,
    ),
});
export type PlanningScript = z.infer<typeof PlanningScriptSchema>;
export const PlanningRequestSchema = z
  .object({
    runId: z.uuid(),
    brief: StoredChannelBriefSchema,
    idea: text.max(20000),
    format: PlanningFormatSchema,
  })
  .strict();
export type PlanningRequest = z.infer<typeof PlanningRequestSchema>;
export const PlanningShotsSchema = z.array(ShotSpecSchema).min(1);
export const ArtPlanSchema = z
  .object({
    character: z.object({ front: text, side: text, fullBody: text }).strict().nullable(),
    styleFrame: text,
    keyframePrompts: z.array(text).min(1),
  })
  .strict();
export type ArtPlan = z.infer<typeof ArtPlanSchema>;
export type ReferencePin = z.infer<typeof ReferencePinSchema>;
export type PlanningPromptReceipt = Readonly<{
  role: "scriptwriter" | "director" | "art-director";
  version: 2 | 3;
  templateVersionId: string;
  promptSnapshotId: string;
  configSnapshotId: string;
  fingerprintSha256: string;
}>;
export type PlanningManifest = Readonly<{
  schemaVersion: "1.0";
  workspaceId: string;
  runId: string;
  briefId: string;
  briefVersion: number;
  narratorVoice: NonNullable<z.infer<typeof StoredChannelBriefSchema>["narratorVoice"]>;
  prompts: readonly PlanningPromptReceipt[];
  shots: readonly z.infer<typeof ShotSpecSchema>[];
}>;

/** Uses the frozen V1 210-wpm budget, scaled by the channel narration pace. */
export function validatePlanningScript(value: unknown, request: PlanningRequest): PlanningScript {
  const script = PlanningScriptSchema.parse(value);
  const pace = request.brief.narratorVoice?.pace ?? 1;
  const body = [...script.beats, script.payoff].join(" ");
  const transcript = planningTranscript(script);
  const count = words(transcript);
  if (script.wordCount !== count) throw new Error("Incorrect script word count");
  if (
    !scriptWordBudget({
      hook: script.hook,
      cta: script.cta,
      dialogue: body,
      scenes: [],
      metadata: { targetDurationSeconds: request.brief.targetDurationSeconds * pace },
    })
  )
    throw new Error("Script exceeds narration duration budget");
  if (script.language !== request.brief.languages.script)
    throw new Error("Script must use Brief language");
  assertCaptionDuration(transcript, Math.min(request.brief.targetDurationSeconds, 45));
  return script;
}

export function planningTranscript(script: PlanningScript): string {
  return [script.hook, ...script.beats, script.payoff, script.cta].join(" ");
}
