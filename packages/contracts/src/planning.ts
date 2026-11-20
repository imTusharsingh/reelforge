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
export const PlanningScriptSchema = z
  .object({
    hook: HookSchema,
    beats: z.array(text).min(3).max(5),
    payoff: text,
    cta: CtaSchema,
    language: text,
    wordCount: z.int().positive(),
  })
  .strict();
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
  version: 2;
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
  const count = words(`${script.hook} ${body} ${script.cta}`);
  if (script.wordCount !== count) throw new Error("Incorrect script word count");
  if (words(script.hook) / (3.5 * pace) > 3) throw new Error("Hook exceeds three seconds");
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
  return script;
}
