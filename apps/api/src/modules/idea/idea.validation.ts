import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export const ideaSchema = z.object({
  title: z.string().trim().min(1).max(240),
  topic: z.string().trim().min(1).max(2000),
  hook: z.string().trim().min(1).max(2000),
  angle: z.string().trim().min(1).max(2000),
  audience: z.string().trim().min(1).max(500),
  references: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  sourceNotes: z.string().trim().max(5000).default(""),
  expectedFormat: z.string().trim().min(1).max(200).default("short-form-video"),
  channelId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
});

export function parseIdeaInput(value: unknown): z.infer<typeof ideaSchema> {
  const result = ideaSchema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues);
  if (result.data.channelId === undefined && result.data.seriesId === undefined)
    throw new BadRequestException("channelId or seriesId is required");
  return result.data;
}

export function parseAiProposal(
  value: unknown,
  scope: { channelId?: string; seriesId?: string },
): z.infer<typeof ideaSchema> {
  const proposal = ideaSchema.partial().parse(value);
  return parseIdeaInput({ ...proposal, ...scope });
}

export const aiIdeaSchema = z.object({
  prompt: z.string().trim().min(1).max(5000),
  context: z.string().max(10000).optional(),
  channelId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
});

export const aiMetadataSchema = z.object({
  modelVersion: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
  cost: z.number().finite().nonnegative().nullable(),
  currency: z.string().trim().min(1).optional(),
});

export const transitionSchema = z
  .object({
    status: z.enum(["BACKLOG", "APPROVED", "REJECTED", "SCHEDULED"]),
    scheduledAt: z.string().datetime().optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "SCHEDULED" && value.scheduledAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "scheduledAt is required",
      });
    if (value.scheduledAt !== undefined && new Date(value.scheduledAt).getTime() <= Date.now())
      context.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "scheduledAt must be in the future",
      });
  });

/** Editing and archiving use the last observed server timestamp to avoid overwriting another editor. */
export const ideaMutationSchema = ideaSchema.extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
export const ideaArchiveSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
export const ideaListQuerySchema = z.object({
  status: z.enum(["DRAFT", "BACKLOG", "APPROVED", "REJECTED", "SCHEDULED"]).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
