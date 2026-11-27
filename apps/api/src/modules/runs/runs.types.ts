import { parseTraceparent } from "@reelforge/observability";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@reelforge/database";
import type { foundationWorkspaceGuard } from "@reelforge/database";
import type { WorkspaceContext } from "../identity/identity.types.js";

export type Scoped = ReturnType<typeof foundationWorkspaceGuard>;
export type Run = Prisma.VideoRunGetPayload<object>;
export type Step = Prisma.VideoRunStepGetPayload<object>;
export type Event = Prisma.RunEventGetPayload<object>;
export type Json = Prisma.InputJsonValue;
export type Transaction = Prisma.TransactionClient;
export type Database = PrismaClient;
export type Context = WorkspaceContext;
/** Internal queue principal. It has no login, session, or workspace membership. */
export const RECOVERY_PRINCIPAL = "0cc1aa5f-0000-4000-8000-000000000001";
export const RunCreateSchema = z
  .object({
    workspaceId: z.uuid(),
    channelBriefId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict();
export const RunJobSchema = z
  .object({
    workspaceId: z.uuid(),
    userId: z.uuid(),
    runId: z.uuid(),
    stepId: z.uuid().optional(),
    assembly: z.literal(true).optional(),
    stage: z.enum(["PLANNING", "SCRIPTING", "SHOT_PLANNING", "CRITIC"]).optional(),
    traceparent: z
      .string()
      .max(55)
      .refine((value) => parseTraceparent(value) !== null)
      .optional(),
  })
  .strict();
export type RunJob = z.infer<typeof RunJobSchema>;
export const ArtifactSchema = z
  .object({
    kind: z.enum([
      "refs",
      "keyframes",
      "clips",
      "narration",
      "music",
      "captions",
      "final",
      "manifest",
    ]),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    objectKey: z.string().regex(/^runs\/(?:permanent|draft\/\d+)\/[a-f0-9]{64}$/),
    contentType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "audio/mpeg",
      "audio/wav",
      "video/mp4",
      "application/json",
      "text/plain",
      "text/vtt",
    ]),
    byteSize: z.int().positive(),
    deliveryChunkHashes: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(512)
      .optional(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export function json(value: unknown): Json {
  return z.json().parse(value) as Json;
}
