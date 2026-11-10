import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "./notifications.catalog.js";

const eventTypeSchema = z.enum(
  NOTIFICATION_EVENT_TYPES as [NotificationEventType, ...NotificationEventType[]],
);

const listNotificationsQuerySchema = z
  .object({
    unread: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    before: z.iso.datetime().optional(),
  })
  .strict();

export type ListNotificationsQuery = Readonly<{
  unreadOnly: boolean;
  limit: number;
  before: Date | null;
}>;

export function parseListNotificationsQuery(value: unknown): ListNotificationsQuery {
  const parsed = listNotificationsQuerySchema.safeParse(value ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return {
    unreadOnly: parsed.data.unread === "true",
    limit: parsed.data.limit ?? 50,
    before: parsed.data.before === undefined ? null : new Date(parsed.data.before),
  };
}

const putPreferencesSchema = z
  .object({
    preferences: z
      .array(
        z.object({ eventType: eventTypeSchema, inApp: z.boolean(), email: z.boolean() }).strict(),
      )
      .min(1)
      .max(NOTIFICATION_EVENT_TYPES.length),
  })
  .strict()
  .superRefine((body, context) => {
    const seen = new Set<string>();
    for (const [index, preference] of body.preferences.entries()) {
      if (seen.has(preference.eventType))
        context.addIssue({
          code: "custom",
          path: ["preferences", index, "eventType"],
          message: "Each eventType may appear only once",
        });
      seen.add(preference.eventType);
    }
  });

export type PutPreferencesRequest = z.infer<typeof putPreferencesSchema>;

export function parsePutPreferences(value: unknown): PutPreferencesRequest {
  const parsed = putPreferencesSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

const periodTypeSchema = z.enum(["DAILY", "WEEKLY"]);

const generateReportSchema = z
  .object({
    channelId: z.uuid(),
    periodType: periodTypeSchema,
    periodStartDate: z.iso.date(),
  })
  .strict();

export type GenerateReportRequest = z.infer<typeof generateReportSchema>;

export function parseGenerateReport(value: unknown): GenerateReportRequest {
  const parsed = generateReportSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

const listReportsQuerySchema = z
  .object({
    channelId: z.uuid().optional(),
    periodType: periodTypeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ListReportsQuery = Readonly<{
  channelId: string | null;
  periodType: "DAILY" | "WEEKLY" | null;
  limit: number;
}>;

export function parseListReportsQuery(value: unknown): ListReportsQuery {
  const parsed = listReportsQuerySchema.safeParse(value ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return {
    channelId: parsed.data.channelId ?? null,
    periodType: parsed.data.periodType ?? null,
    limit: parsed.data.limit ?? 50,
  };
}

export function parseUuid(value: string, name: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException(`${name} must be a UUID`);
  return parsed.data;
}
