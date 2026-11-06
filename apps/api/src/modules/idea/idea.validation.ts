import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const ideaSchema = z.object({
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

export const aiIdeaSchema = z.object({
  prompt: z.string().trim().min(1).max(5000),
  context: z.string().max(10000).optional(),
});
