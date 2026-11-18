import { z } from "zod";
/** V9's temporary V6 boundary, replaced by the landed packaging export during integration.
 * IDs bind the package to the retained M13 render and current hard-gate review, not a fabricated approval.
 */
export const PublishingPackageSchema = z
  .object({
    videoRunId: z.uuid().optional(),
    criticStepId: z.uuid().optional(),
    assemblyStepId: z.uuid().optional(),
    renderJobId: z.uuid().optional(),
    qualityReviewRunId: z.uuid().optional(),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(4800),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    coverFrameTimestampMs: z.number().int().nonnegative().optional(),
    coverFrame: z.string().min(1).optional(),
    containsSyntheticMedia: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      (value.videoRunId && value.criticStepId && value.assemblyStepId) ||
      (value.renderJobId && value.qualityReviewRunId),
    "A complete publishing source is required",
  )
  .refine(
    (value) => value.coverFrameTimestampMs !== undefined || value.coverFrame !== undefined,
    "A cover frame is required",
  );
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
