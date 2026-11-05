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
  payload: z
    .object({
      postId: z.uuid(),
      platform: z.string().min(1),
      platformPostId: z.string().min(1),
    })
    .strict(),
}).strict();

export const PublishFailedV1Schema = EventBaseSchema.extend({
  eventType: z.literal("PublishFailed"),
  eventVersion: z.literal(1),
  payload: z
    .object({
      postId: z.uuid(),
      failureCode: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict(),
}).strict();

const EventRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    strategy: z.literal("exponential"),
    initialDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
    deadLetterQueue: z.string().min(1),
  })
  .strict();

const eventRetryPolicy = EventRetryPolicySchema.parse({
  maxAttempts: 5,
  strategy: "exponential",
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  deadLetterQueue: "reelforge.events.dead-letter",
});

export const eventRegistry = {
  "PostPublished@1": {
    eventType: "PostPublished",
    eventVersion: 1,
    schema: PostPublishedV1Schema,
    producerModule: "M13-publishing-calendar-and-delivery",
    consumers: ["M14-analytics-collection-and-metric-store", "M17-notifications-and-reporting"],
    retryPolicy: eventRetryPolicy,
  },
  "PublishFailed@1": {
    eventType: "PublishFailed",
    eventVersion: 1,
    schema: PublishFailedV1Schema,
    producerModule: "M13-publishing-calendar-and-delivery",
    consumers: ["M16-workflow-orchestration-and-scheduler", "M17-notifications-and-reporting"],
    retryPolicy: eventRetryPolicy,
  },
} as const;

export type RegisteredEvent =
  z.infer<typeof PostPublishedV1Schema> | z.infer<typeof PublishFailedV1Schema>;
export type RegisteredEventName = (typeof eventRegistry)[keyof typeof eventRegistry]["eventType"];
export type EventRetryPolicy = z.infer<typeof EventRetryPolicySchema>;

type EventRegistryKey = keyof typeof eventRegistry;

function isEventRegistryKey(key: string): key is EventRegistryKey {
  return Object.prototype.hasOwnProperty.call(eventRegistry, key);
}

export function parseRegisteredEvent(input: unknown): RegisteredEvent {
  const header = EventBaseSchema.pick({ eventType: true, eventVersion: true }).parse(input);
  const registryKey = `${header.eventType}@${header.eventVersion}`;
  if (!isEventRegistryKey(registryKey)) {
    throw new Error(`Unregistered event version: ${registryKey}`);
  }
  return eventRegistry[registryKey].schema.parse(input);
}
