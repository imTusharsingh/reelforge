import { z } from "zod";
export const AlignedWordSchema = z
  .object({ text: z.string().min(1), start: z.number().nonnegative(), end: z.number().positive() })
  .strict()
  .refine((word) => word.end > word.start, "Word interval must be positive");
export type AlignedWord = z.infer<typeof AlignedWordSchema>;
export const MediaReceiptSchema = z
  .object({
    key: z.string().min(1),
    providerId: z.string().min(1),
    providerJobId: z.string().min(1),
    costBasis: z.enum(["RESERVATION", "BILLED"]).default("RESERVATION"),
    modelId: z.string().min(1),
    promptVersion: z.string().min(1),
    seconds: z.number().nonnegative(),
    providerDurationSeconds: z.number().nonnegative().optional(),
    costMinor: z.int().nonnegative(),
    objectKey: z.string().regex(/^runs\/(?:permanent|draft\/\d+)\/[a-f0-9]{64}$/),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().min(1),
  })
  .strict();
export type MediaReceipt = z.infer<typeof MediaReceiptSchema>;
export const AssemblyManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    briefId: z.uuid(),
    briefVersion: z.int().positive(),
    durationSeconds: z.number().min(30).max(45),
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(24),
    videoCodec: z.literal("h264"),
    narrationLanguage: z.string().min(1),
    receipts: z.array(MediaReceiptSchema).min(1),
    words: z.array(AlignedWordSchema).min(1),
    promptVersions: z.array(z.json()).min(1),
    totalCostMinor: z.int().nonnegative().max(800),
    videoChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AssemblyManifest = z.infer<typeof AssemblyManifestSchema>;
