import { z } from "zod";
/** V9's temporary V6 boundary, replaced by the landed packaging export during integration.
 * IDs bind the package to the retained M13 render and current hard-gate review, not a fabricated approval.
 */
export const PublishingPackageSchema = z
  .object({
    renderJobId: z.uuid(),
    qualityReviewRunId: z.uuid(),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(4800),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
    coverFrame: z.string().min(1),
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
