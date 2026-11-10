import { z } from "zod";
import { SocialPlatformSchema } from "./social-accounts.js";

export const AnalyticsMetricKeySchema = z.enum([
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
]);
export type AnalyticsMetricKey = z.infer<typeof AnalyticsMetricKeySchema>;

export const AnalyticsGranularitySchema = z.enum(["CHANNEL", "VIDEO"]);
export type AnalyticsGranularity = z.infer<typeof AnalyticsGranularitySchema>;

export const MetricCompletenessSchema = z.enum(["COMPLETE", "PARTIAL", "UNAVAILABLE"]);
export type MetricCompleteness = z.infer<typeof MetricCompletenessSchema>;

export const MetricAvailabilitySchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
export type MetricAvailability = z.infer<typeof MetricAvailabilitySchema>;

export const AnalyticsMetricDefinitionSchema = z
  .object({
    platform: SocialPlatformSchema,
    key: AnalyticsMetricKeySchema,
    label: z.string().min(1),
    description: z.string().min(1),
    accountEligibility: z.string().min(1),
    requiredScopes: z.array(z.string().min(1)).min(1),
    granularities: z.array(AnalyticsGranularitySchema).min(1),
    sourceApi: z.string().min(1),
    documentationUrl: z.url(),
    availabilityNotes: z.string().min(1),
    verifiedAt: z.iso.date(),
  })
  .strict();
export type AnalyticsMetricDefinition = z.infer<typeof AnalyticsMetricDefinitionSchema>;

export const MetricCollectionRequestSchema = z
  .object({
    channelId: z.uuid(),
    socialAccountId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
  });
export type MetricCollectionRequest = z.infer<typeof MetricCollectionRequestSchema>;

export const MetricAggregateRequestSchema = z
  .object({
    socialAccountId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    granularity: AnalyticsGranularitySchema,
    remoteEntityId: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
  })
  .refine(
    (value) =>
      (value.granularity === "CHANNEL" && value.remoteEntityId === undefined) ||
      (value.granularity === "VIDEO" && value.remoteEntityId !== undefined),
    {
      message: "VIDEO queries require remoteEntityId; CHANNEL queries must omit it",
      path: ["remoteEntityId"],
    },
  );
export type MetricAggregateRequest = z.infer<typeof MetricAggregateRequestSchema>;

export const NormalizedMetricValueSchema = z
  .object({
    key: AnalyticsMetricKeySchema,
    value: z.number().finite().nonnegative().nullable(),
    unit: z.enum(["COUNT", "MINUTES"]),
    entityGranularity: AnalyticsGranularitySchema,
    remoteEntityId: z.string().min(1).nullable(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    collectedAt: z.iso.datetime(),
    sourceApi: z.string().min(1),
    completeness: MetricCompletenessSchema,
    availability: MetricAvailabilitySchema,
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict()
  .refine((value) => value.periodStart === value.periodEnd, {
    message: "Analytics snapshots must represent one reporting day",
    path: ["periodEnd"],
  })
  .refine(
    (value) =>
      (value.entityGranularity === "CHANNEL" && value.remoteEntityId === null) ||
      (value.entityGranularity === "VIDEO" && value.remoteEntityId !== null),
    {
      message: "VIDEO snapshots require a remoteEntityId; CHANNEL snapshots must omit it",
      path: ["remoteEntityId"],
    },
  )
  .refine(
    (value) =>
      (value.availability === "AVAILABLE" && value.value !== null) ||
      (value.availability === "UNAVAILABLE" &&
        value.value === null &&
        value.unavailableReason !== null),
    { message: "Metric availability must agree with its value and reason" },
  );
export type NormalizedMetricValue = z.infer<typeof NormalizedMetricValueSchema>;

export const MetricAggregateSchema = z
  .object({
    key: AnalyticsMetricKeySchema,
    value: z.number().finite().nonnegative().nullable(),
    unit: z.enum(["COUNT", "MINUTES"]),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    collectedAt: z.iso.datetime().nullable(),
    sourceApis: z.array(z.string().min(1)),
    completeness: MetricCompletenessSchema,
    unavailableDays: z.number().int().nonnegative(),
  })
  .strict();
export type MetricAggregate = z.infer<typeof MetricAggregateSchema>;

export const LatestMetricSnapshotSchema = z
  .object({
    id: z.uuid(),
    key: AnalyticsMetricKeySchema,
    value: z.number().finite().nonnegative().nullable(),
    unit: z.enum(["COUNT", "MINUTES"]),
    entityGranularity: AnalyticsGranularitySchema,
    remoteEntityId: z.string().min(1).nullable(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    collectedAt: z.iso.datetime(),
    sourceApi: z.string().min(1),
    completeness: MetricCompletenessSchema,
    availability: MetricAvailabilitySchema,
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict();
export type LatestMetricSnapshot = z.infer<typeof LatestMetricSnapshotSchema>;

export const LatestMetricSnapshotQuerySchema = z
  .object({
    channelId: z.uuid(),
    socialAccountId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    granularity: AnalyticsGranularitySchema,
    remoteEntityId: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
  })
  .refine((value) => value.granularity === "VIDEO" || value.remoteEntityId === undefined, {
    message: "CHANNEL queries must omit remoteEntityId",
    path: ["remoteEntityId"],
  });
export type LatestMetricSnapshotQuery = z.infer<typeof LatestMetricSnapshotQuerySchema>;

export const YouTubeAnalyticsReportSchema = z
  .object({
    kind: z.string().min(1).optional(),
    columnHeaders: z.array(
      z
        .object({
          name: z.string().min(1),
          columnType: z.string().optional(),
          dataType: z.string().optional(),
        })
        .strict(),
    ),
    // Official reports.query omits `rows` when a query has no data.
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .nullable()
      .optional(),
  })
  .strict();
export type YouTubeAnalyticsReport = z.infer<typeof YouTubeAnalyticsReportSchema>;
