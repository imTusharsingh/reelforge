import { z } from "zod";
import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
import { BadRequestException } from "@nestjs/common";
const uuid = z.string().uuid();
const caption = z
  .object({
    text: z.string().trim().min(1).max(500),
    startMs: z.int().min(0),
    endMs: z.int().positive(),
  })
  .strict();
const scene = z
  .object({
    sceneId: z.string().trim().min(1).max(200),
    assetId: uuid,
    assetVersion: z.int().positive(),
    image: z.boolean(),
    durationMs: z.int().min(100).max(300_000),
    narrationAssetId: uuid.optional(),
    narrationAssetVersion: z.int().positive().optional(),
    captions: z.array(caption).max(200).default([]),
  })
  .strict();
const audio = z
  .object({ kind: z.enum(["MUSIC", "SFX"]), assetId: uuid, assetVersion: z.int().positive() })
  .strict();
const cover = z
  .object({ assetId: uuid, assetVersion: z.int().positive(), timestampMs: z.int().min(0) })
  .strict();
const profile = z
  .object({
    id: z.literal(DEFAULT_RENDER_PROFILE.id),
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(24),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac"),
    audioSampleRate: z.literal(48000),
    audioChannels: z.literal(2),
    captionSafeMarginPixels: z.int().min(24).max(400).default(120),
    transition: z.enum(["CUT", "FADE"]).default("CUT"),
    transitionDurationMs: z.int().min(0).max(2000).default(0),
  })
  .strict();
const inputSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    title: z.string().trim().min(1).max(250),
    profile,
    sourceMediaPackage: z
      .object({
        jobId: uuid,
        scriptId: uuid,
        scriptRevision: z.int().positive(),
        schemaVersion: z.literal("1.0"),
      })
      .strict(),
    scenes: z.array(scene).min(1).max(100),
    audio: z.array(audio).max(10).default([]),
    coverFrames: z.array(cover).min(1).max(5),
    renderSeed: z.string().min(8).max(100),
  })
  .strict();
export const createRenderSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    input: inputSchema,
    retentionDays: z.int().min(1).max(3650).default(90),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  return result.data;
}
