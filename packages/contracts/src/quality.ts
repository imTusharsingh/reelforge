import { z } from "zod";

export const QualityRubricSchema = z
  .object({
    hook: z.number().int().min(0).max(10),
    coherence: z.number().int().min(0).max(10),
    artifacts: z.number().int().min(0).max(10),
    captionSync: z.number().int().min(0).max(10),
    briefFit: z.number().int().min(0).max(10),
    policy: z.number().int().min(0).max(10),
  })
  .strict();

export const PackagingSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(5000),
    tags: z.array(z.string().trim().min(1).max(100)).max(30),
    coverFrameTimestampMs: z.number().int().nonnegative(),
    containsSyntheticMedia: z.literal(true),
  })
  .strict();

export type QualityRubric = z.infer<typeof QualityRubricSchema>;
export type Packaging = z.infer<typeof PackagingSchema>;
