import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type { ScriptDocument } from "./script.types.js";

const scene = z.object({
  id: z.string().min(1),
  startSeconds: z.number().finite().nonnegative(),
  durationSeconds: z.number().finite().positive(),
  characterRefs: z.array(
    z.object({ characterId: z.string().uuid(), versionId: z.string().uuid() }),
  ),
  dialogue: z.string(),
  narration: z.string().optional(),
  visualDescription: z.string().min(1),
  camera: z.string().min(1),
  audioCues: z.array(z.string()),
  transition: z.string().optional(),
});
export const scriptDocumentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().min(1),
  hook: z.string().min(1),
  dialogue: z.string(),
  narration: z.string().optional(),
  cta: z.string().min(1),
  metadata: z.object({
    genre: z.string().min(1),
    targetDurationSeconds: z.number().finite().positive(),
    factual: z.boolean(),
  }),
  scenes: z.array(scene).min(1),
  claims: z.array(z.object({ text: z.string().min(1), sourceUrl: z.string().url() })).optional(),
});
export function parseScriptDocument(value: unknown): ScriptDocument {
  const result = scriptDocumentSchema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data as ScriptDocument;
}
export function validateScript(document: ScriptDocument, toleranceSeconds = 1): void {
  const total = document.scenes.reduce((sum, item) => sum + item.durationSeconds, 0);
  if (Math.abs(total - document.metadata.targetDurationSeconds) > toleranceSeconds)
    throw new BadRequestException("Scene duration does not match target duration");
  if (document.metadata.factual && (!document.claims || document.claims.length === 0))
    throw new BadRequestException("Factual scripts require source-backed claims");
  const ids = new Set(document.scenes.map((item) => item.id));
  if (ids.size !== document.scenes.length)
    throw new BadRequestException("Scene IDs must be unique");
}
