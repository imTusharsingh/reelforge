import { z } from "zod";

const text = z.string().trim().min(1);

export const narratorPaceMin = 0.5;
export const narratorPaceMax = 2;
export const narratorPaceMessage = `Narrator pace must be between ${narratorPaceMin} and ${narratorPaceMax}.`;
export const NarratorPaceSchema = z
  .number()
  .min(narratorPaceMin, narratorPaceMessage)
  .max(narratorPaceMax, narratorPaceMessage)
  .default(1);

export const StoredNarratorVoiceSchema = z
  .object({
    providerId: text,
    voiceId: text,
    language: text.default("English"),
    pace: z.number().positive().default(1),
  })
  .strict();
export const NarratorVoiceSchema = StoredNarratorVoiceSchema.extend({ pace: NarratorPaceSchema });
