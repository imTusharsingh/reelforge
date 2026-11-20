import type { z } from "zod";
import type { ChannelBriefShape } from "./foundations.js";

export function validateBriefDuplicates(
  brief: Pick<
    z.infer<typeof ChannelBriefShape>,
    | "formatKey"
    | "formatMix"
    | "languages"
    | "narrationLanguage"
    | "narratorVoice"
    | "guardrails"
    | "aiDisclosure"
  >,
  ctx: z.RefinementCtx,
): void {
  if (!brief.formatMix.some(({ formatKey }) => formatKey === brief.formatKey))
    ctx.addIssue({
      code: "custom",
      path: ["formatKey"],
      message: "Format must occur in formatMix",
    });
  if (brief.narrationLanguage !== brief.languages.narration)
    ctx.addIssue({
      code: "custom",
      path: ["narrationLanguage"],
      message: "Must match languages.narration",
    });
  if (brief.narratorVoice && brief.narratorVoice.language !== brief.languages.narration)
    ctx.addIssue({
      code: "custom",
      path: ["narratorVoice", "language"],
      message: "Must match languages.narration",
    });
  if (brief.aiDisclosure !== brief.guardrails.aiDisclosure)
    ctx.addIssue({
      code: "custom",
      path: ["aiDisclosure"],
      message: "Must match guardrails.aiDisclosure",
    });
}
