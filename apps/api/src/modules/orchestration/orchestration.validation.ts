import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type { WorkflowRunInput } from "./orchestration.types.js";

const definitionKeySchema = z.enum(["GENERATION", "PUBLISH", "ANALYTICS"]);

const outputsSchema = z
  .object({
    image: z.literal(true),
    video: z.boolean().optional(),
    narration: z.boolean().optional(),
    dialogue: z.boolean().optional(),
  })
  .strict();

const manualRunBodySchema = z
  .object({
    definitionKey: definitionKeySchema.default("GENERATION"),
    channelId: z.uuid().optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    ideaId: z.uuid().optional(),
    approvedIdeaSnapshotId: z.uuid().optional(),
    approvedIdeaChecksum: z.string().min(1).max(200).optional(),
    scriptId: z.uuid().optional(),
    prompt: z.string().min(1).max(20_000).optional(),
    configSnapshotId: z.uuid().optional(),
    promptSnapshotId: z.uuid().optional(),
    outputs: outputsSchema.optional(),
    sceneMediaJobId: z.uuid().optional(),
    renderJobId: z.uuid().optional(),
    renderInput: z.unknown().optional(),
    qualityReviewRunId: z.uuid().optional(),
    publishingDestinationId: z.uuid().optional(),
    scheduledPostId: z.uuid().optional(),
    socialAccountId: z.uuid().optional(),
    analyticsStartDate: z.iso.date().optional(),
    analyticsEndDate: z.iso.date().optional(),
    skipPublish: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.definitionKey === "GENERATION" && body.channelId === undefined)
      context.addIssue({
        code: "custom",
        path: ["channelId"],
        message: "channelId is required for a generation run",
      });
    if (
      body.definitionKey === "GENERATION" &&
      body.ideaId === undefined &&
      body.scriptId === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["ideaId"],
        message: "ideaId or scriptId is required for a generation run",
      });
    if (
      body.definitionKey === "PUBLISH" &&
      body.publishingDestinationId === undefined &&
      body.scheduledPostId === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["publishingDestinationId"],
        message: "publishingDestinationId or scheduledPostId is required for a publish run",
      });
    if (
      body.definitionKey === "ANALYTICS" &&
      (body.channelId === undefined ||
        body.socialAccountId === undefined ||
        body.analyticsStartDate === undefined ||
        body.analyticsEndDate === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["channelId"],
        message:
          "channelId, socialAccountId, analyticsStartDate, and analyticsEndDate are required for an analytics run",
      });
  });

export type ManualRunRequest = z.infer<typeof manualRunBodySchema>;

export function parseManualRunBody(body: unknown): ManualRunRequest {
  const parsed = manualRunBodySchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function manualRunInput(request: ManualRunRequest): WorkflowRunInput {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined) input[key] = value;
  }
  return input;
}

export function parseRunId(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException("runId must be a UUID");
  return parsed.data;
}
