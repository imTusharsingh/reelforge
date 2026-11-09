import { z } from "zod";
import { SocialPlatformSchema } from "./social-accounts.js";

export const YouTubePrivacyStatusSchema = z.enum(["private", "unlisted", "public"]);
export type YouTubePrivacyStatus = z.infer<typeof YouTubePrivacyStatusSchema>;

export const YouTubeDestinationMetadataSchema = z
  .object({
    platform: z.literal("YOUTUBE"),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(5000),
    tags: z.array(z.string().trim().min(1).max(500)).max(500).optional(),
    categoryId: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional(),
    privacyStatus: YouTubePrivacyStatusSchema,
    selfDeclaredMadeForKids: z.boolean(),
  })
  .strict();
export type YouTubeDestinationMetadata = z.infer<typeof YouTubeDestinationMetadataSchema>;

export const DisclosureDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("DISCLOSE"),
      disclosureText: z.string().trim().min(1).max(1000),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      decision: z.literal("NOT_REQUIRED"),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type DisclosureDecision = z.infer<typeof DisclosureDecisionSchema>;

export const PublishedPostRecordSchema = z
  .object({
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    scheduledPostId: z.uuid(),
    destinationId: z.uuid(),
    publishJobId: z.uuid(),
    renderJobId: z.uuid(),
    accountId: z.uuid(),
    platform: SocialPlatformSchema,
    platformPostId: z.string().min(1).max(255),
    publishedAt: z.iso.datetime(),
  })
  .strict();
export type PublishedPostRecord = z.infer<typeof PublishedPostRecordSchema>;
