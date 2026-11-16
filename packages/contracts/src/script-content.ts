import { z } from "zod";

export const words = (value: string): number => value.trim().split(/\s+/u).filter(Boolean).length;
function boundedWords(max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => words(value) <= max, `Maximum ${max} words`);
}
export const HookSchema = boundedWords(20);
export const CtaSchema = boundedWords(15);
/** Conservative speech budget: 210 words/minute. Scene body avoids duplicate aggregate text. */
export function scriptWordBudget(input: {
  hook: string;
  cta: string;
  dialogue: string;
  narration?: string | undefined;
  metadata: { targetDurationSeconds: number };
  scenes: readonly { dialogue: string; narration?: string | undefined }[];
}): boolean {
  const sceneBody = input.scenes
    .map((scene) => `${scene.dialogue} ${scene.narration ?? ""}`)
    .join(" ")
    .trim();
  const body = sceneBody || `${input.dialogue} ${input.narration ?? ""}`;
  return (
    words(`${input.hook} ${body} ${input.cta}`) <=
    Math.ceil(input.metadata.targetDurationSeconds * 3.5)
  );
}
