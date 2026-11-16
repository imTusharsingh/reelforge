import { z } from "zod";
import { HookSchema, CtaSchema } from "@reelforge/contracts";
export const generateSchema = z.object({
  approvedIdeaSnapshotId: z.uuid(),
  approvedIdeaChecksum: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  channelId: z.uuid().optional(),
  correlationId: z.uuid().optional(),
  configSnapshotId: z.uuid(),
  promptSnapshotId: z.uuid(),
  hook: HookSchema.optional(),
  cta: CtaSchema.optional(),
});
export const providerEnvelopeSchema = z.looseObject({
  output: z.unknown(),
  metadata: z.unknown().optional(),
  providerRequestId: z.unknown().optional(),
});
const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(),
});
export const provenanceSchema = z.object({
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  cost: z.number().finite().nonnegative().nullable(),
  currency: z.string().min(1).optional(),
  usage: providerUsageSchema.optional(),
});
export const promptBundleSchema = z.object({
  renderedText: z.string().min(1),
  fingerprintSha256: z.string().length(64),
});
export type Reservation = {
  id: string;
  budgetId: string;
  periodStart: string;
  reservedAmount: number;
};
