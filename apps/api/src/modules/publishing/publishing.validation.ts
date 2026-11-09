import { z } from "zod";
import { DisclosureDecisionSchema, YouTubeDestinationMetadataSchema } from "@reelforge/contracts";

const InstagramDestinationMetadataSchema = z
  .object({
    platform: z.literal("INSTAGRAM"),
    caption: z.string().max(2200),
  })
  .strict();

export const PublishingDestinationInputSchema = z.discriminatedUnion("platform", [
  z
    .object({
      platform: z.literal("YOUTUBE"),
      socialAccountId: z.uuid(),
      metadata: YouTubeDestinationMetadataSchema,
    })
    .strict(),
  z
    .object({
      platform: z.literal("INSTAGRAM"),
      socialAccountId: z.uuid(),
      metadata: InstagramDestinationMetadataSchema,
    })
    .strict(),
]);

export const CreateScheduledPostSchema = z
  .object({
    channelId: z.uuid(),
    renderJobId: z.uuid(),
    qualityReviewRunId: z.uuid(),
    scheduledAt: z.iso.datetime({ offset: true }).nullable(),
    disclosure: DisclosureDecisionSchema,
    destinations: z.array(PublishingDestinationInputSchema).min(1).max(5),
  })
  .strict()
  .superRefine((request, context) => {
    const accountIds = request.destinations.map((destination) => destination.socialAccountId);
    if (new Set(accountIds).size !== accountIds.length) {
      context.addIssue({
        code: "custom",
        message: "Each connected account may appear only once per scheduled post",
        path: ["destinations"],
      });
    }
  });

export const UpdateScheduledPostSchema = z
  .object({
    scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
    disclosure: DisclosureDecisionSchema.optional(),
  })
  .strict()
  .refine(
    (request) => request.scheduledAt !== undefined || request.disclosure !== undefined,
    "At least one mutable field is required",
  );

export const CalendarRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((range) => Date.parse(range.from) < Date.parse(range.to), {
    message: "Calendar range end must be after its start",
    path: ["to"],
  });

export type CreateScheduledPost = z.infer<typeof CreateScheduledPostSchema>;
export type UpdateScheduledPost = z.infer<typeof UpdateScheduledPostSchema>;
export type PublishingDestinationInput = z.infer<typeof PublishingDestinationInputSchema>;
