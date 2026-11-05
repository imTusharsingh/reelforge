import { z } from "zod";
import { CorrelationIdSchema } from "./api.js";

const EventBaseSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  workspaceId: z.uuid(),
  channelId: z.uuid().optional(),
  correlationId: CorrelationIdSchema,
  causationId: z.uuid().optional(),
  idempotencyKey: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.uuid(),
});

export const PostPublishedV1Schema = EventBaseSchema.extend({
  eventType: z.literal("PostPublished"),
  eventVersion: z.literal(1),
  payload: z.object({
    postId: z.uuid(),
    platform: z.string().min(1),
    platformPostId: z.string().min(1),
  }).strict(),
}).strict();

export const PublishFailedV1Schema = EventBaseSchema.extend({
  eventType: z.literal("PublishFailed"),
  eventVersion: z.literal(1),
  payload: z.object({
    postId: z.uuid(),
    failureCode: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const eventRegistry = {
  PostPublished: { 1: PostPublishedV1Schema },
  PublishFailed: { 1: PublishFailedV1Schema },
} as const;

export type RegisteredEvent = z.infer<typeof PostPublishedV1Schema> | z.infer<typeof PublishFailedV1Schema>;
export type RegisteredEventName = keyof typeof eventRegistry;

export function parseRegisteredEvent(input: unknown): RegisteredEvent {
  const header = EventBaseSchema.extend({ eventType: z.string(), eventVersion: z.number().int() }).parse(input);
  switch (header.eventType) {
    case "PostPublished":
      return PostPublishedV1Schema.parse(input);
    case "PublishFailed":
      return PublishFailedV1Schema.parse(input);
    default:
      throw new Error(`Unregistered event type: ${header.eventType}`);
  }
}
