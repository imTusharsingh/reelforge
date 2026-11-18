import { z } from "zod";
/** The immutable VideoRun source bound to an automation slot. */
export const PublishingPackageSchema = z
  .object({
    videoRunId: z.uuid(),
    criticStepId: z.uuid(),
    assemblyStepId: z.uuid(),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(4800),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    coverFrameTimestampMs: z.number().int().nonnegative(),
    containsSyntheticMedia: z.literal(true),
  })
  .strict();
export type PublishingPackage = z.infer<typeof PublishingPackageSchema>;
export const AutoSlotViewSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  channelId: z.uuid(),
  scheduledAt: z.string(),
  timezone: z.string(),
  status: z.string(),
  scheduledPostId: z.uuid().nullable(),
  lastError: z.string().nullable(),
  package: PublishingPackageSchema,
});
export const AutoSlotViewsSchema = z.array(AutoSlotViewSchema);
export type AutoSlotView = z.infer<typeof AutoSlotViewSchema>;
