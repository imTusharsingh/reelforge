import { z } from "zod";
import { MetricCompletenessSchema } from "./analytics.js";

export const PerformanceKpiKeySchema = z.enum([
  "TOTAL_VIEWS",
  "ENGAGEMENT_RATE",
  "WATCH_MINUTES_PER_VIEW",
  "NET_SUBSCRIBERS",
  "VIEWS_PER_DAY",
]);
export type PerformanceKpiKey = z.infer<typeof PerformanceKpiKeySchema>;

export const PerformanceDimensionSchema = z.enum([
  "TOPIC",
  "HOOK",
  "DURATION",
  "CHARACTER",
  "SERIES",
  "PUBLISH_TIMING",
]);
export type PerformanceDimension = z.infer<typeof PerformanceDimensionSchema>;

export const PerformanceConfidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type PerformanceConfidence = z.infer<typeof PerformanceConfidenceSchema>;

export const PerformanceDataStatusSchema = z.enum(["OK", "INSUFFICIENT_DATA"]);
export type PerformanceDataStatus = z.infer<typeof PerformanceDataStatusSchema>;

export const InsightReportStatusSchema = z.enum([
  "GENERATED",
  "NOT_GENERATED",
  "INSUFFICIENT_DATA",
]);
export type InsightReportStatus = z.infer<typeof InsightReportStatusSchema>;

export const InsightAiStatusSchema = z.enum([
  "GENERATED",
  "NOT_CONFIGURED",
  "NOT_GENERATED",
  "INSUFFICIENT_DATA",
]);
export type InsightAiStatus = z.infer<typeof InsightAiStatusSchema>;

export const RecommendationStatusSchema = z.enum(["PROPOSED", "APPROVED", "REJECTED"]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

export const ExperimentStatusSchema = z.enum(["DRAFT", "RUNNING", "COMPLETED", "REJECTED"]);
export type ExperimentStatus = z.infer<typeof ExperimentStatusSchema>;

export const StrategyChangeStatusSchema = z.enum(["APPROVED", "EXPORTED"]);
export type StrategyChangeStatus = z.infer<typeof StrategyChangeStatusSchema>;

export const PerformanceWindowSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must be on or before endDate",
    path: ["startDate"],
  });
export type PerformanceWindow = z.infer<typeof PerformanceWindowSchema>;

export const PerformanceSampleSchema = z
  .object({
    videos: z.int().nonnegative(),
    days: z.int().nonnegative(),
    snapshots: z.int().nonnegative(),
  })
  .strict();
export type PerformanceSample = z.infer<typeof PerformanceSampleSchema>;

export const PerformanceMinimumsSchema = z
  .object({
    videos: z.int().nonnegative(),
    days: z.int().nonnegative(),
    snapshots: z.int().nonnegative(),
  })
  .strict();
export type PerformanceMinimums = z.infer<typeof PerformanceMinimumsSchema>;

export const PerformanceKpiDefinitionSchema = z
  .object({
    key: PerformanceKpiKeySchema,
    label: z.string().min(1),
    description: z.string().min(1),
    unit: z.enum(["COUNT", "RATIO", "MINUTES"]),
    formula: z.string().min(1),
    comparisonWindowDays: z.int().positive(),
    minimumSample: PerformanceMinimumsSchema,
  })
  .strict();
export type PerformanceKpiDefinition = z.infer<typeof PerformanceKpiDefinitionSchema>;

export const PerformanceKpiResultSchema = z
  .object({
    key: PerformanceKpiKeySchema,
    status: PerformanceDataStatusSchema,
    value: z.number().finite().nullable(),
    previousValue: z.number().finite().nullable(),
    changePercent: z.number().finite().nullable(),
    unit: z.enum(["COUNT", "RATIO", "MINUTES"]),
    currentWindow: PerformanceWindowSchema,
    previousWindow: PerformanceWindowSchema,
    sample: PerformanceSampleSchema,
    minimumSample: PerformanceMinimumsSchema,
    completeness: MetricCompletenessSchema,
    snapshotIds: z.array(z.uuid()),
    collectedAt: z.iso.datetime().nullable(),
    limitations: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (value) =>
      (value.status === "OK" && value.value !== null) ||
      (value.status === "INSUFFICIENT_DATA" && value.value === null),
    { message: "KPI status must agree with its value" },
  );
export type PerformanceKpiResult = z.infer<typeof PerformanceKpiResultSchema>;

export const PerformanceDimensionSummarySchema = z
  .object({
    dimension: PerformanceDimensionSchema,
    value: z.string().min(1),
    status: PerformanceDataStatusSchema,
    sample: PerformanceSampleSchema,
    minimumSample: PerformanceMinimumsSchema,
    totalViews: z.number().finite().nullable(),
    averageViewsPerVideo: z.number().finite().nullable(),
    engagementRate: z.number().finite().nullable(),
    watchMinutesPerView: z.number().finite().nullable(),
    netSubscribers: z.number().finite().nullable(),
    snapshotIds: z.array(z.uuid()),
    publishedPostIds: z.array(z.uuid()),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type PerformanceDimensionSummary = z.infer<typeof PerformanceDimensionSummarySchema>;

export const PerformanceProviderMetadataSchema = z
  .object({
    providerId: z.string().min(1),
    modelVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    cost: z.number().finite().nonnegative().nullable(),
    currency: z.string().min(1).nullable(),
  })
  .strict();
export type PerformanceProviderMetadata = z.infer<typeof PerformanceProviderMetadataSchema>;

export const PerformanceInsightReportSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    status: InsightReportStatusSchema,
    currentWindow: PerformanceWindowSchema,
    previousWindow: PerformanceWindowSchema,
    kpis: z.array(PerformanceKpiResultSchema),
    dimensions: z.array(PerformanceDimensionSummarySchema),
    narrative: z.string().min(1).nullable(),
    aiStatus: InsightAiStatusSchema,
    provider: PerformanceProviderMetadataSchema.nullable(),
    limitations: z.array(z.string().min(1)),
    snapshotIds: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceInsightReport = z.infer<typeof PerformanceInsightReportSchema>;

export const PerformanceRecommendationSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    reportId: z.uuid().nullable(),
    rank: z.int().positive(),
    dimension: PerformanceDimensionSchema,
    action: z.string().min(1),
    rationale: z.string().min(1),
    confidence: PerformanceConfidenceSchema,
    limitations: z.array(z.string().min(1)),
    evidenceSnapshotIds: z.array(z.uuid()),
    status: RecommendationStatusSchema,
    approvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceRecommendation = z.infer<typeof PerformanceRecommendationSchema>;

export const PerformanceExperimentSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    hypothesis: z.string().min(1),
    variant: z.string().min(1),
    dimensions: z.array(PerformanceDimensionSchema).min(1),
    designNotes: z.string().min(1),
    exposure: z.int().nonnegative().nullable(),
    outcome: z.record(z.string(), z.unknown()).nullable(),
    status: ExperimentStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceExperiment = z.infer<typeof PerformanceExperimentSchema>;

export const PerformanceStrategyChangeSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    version: z.int().positive(),
    recommendationId: z.uuid().nullable(),
    summary: z.string().min(1),
    changes: z.record(z.string(), z.unknown()),
    evidenceSnapshotIds: z.array(z.uuid()),
    status: StrategyChangeStatusSchema,
    approvedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceStrategyChange = z.infer<typeof PerformanceStrategyChangeSchema>;

export const GenerateInsightReportRequestSchema = z
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
export type GenerateInsightReportRequest = z.infer<typeof GenerateInsightReportRequestSchema>;

export const GenerateRecommendationsRequestSchema = z
  .object({
    reportId: z.uuid(),
  })
  .strict();
export type GenerateRecommendationsRequest = z.infer<typeof GenerateRecommendationsRequestSchema>;

export const CreateExperimentRequestSchema = z
  .object({
    channelId: z.uuid(),
    hypothesis: z.string().trim().min(1).max(2000),
    variant: z.string().trim().min(1).max(2000),
    dimensions: z.array(PerformanceDimensionSchema).min(1).max(6),
    designNotes: z.string().trim().max(4000).default(""),
    exposure: z.int().nonnegative().optional(),
  })
  .strict();
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequestSchema>;

export const RecordExperimentOutcomeRequestSchema = z
  .object({
    outcome: z.record(z.string(), z.unknown()),
    exposure: z.int().nonnegative().optional(),
  })
  .strict();
export type RecordExperimentOutcomeRequest = z.infer<typeof RecordExperimentOutcomeRequestSchema>;

export const ExportStrategyChangeRequestSchema = z
  .object({
    recommendationId: z.uuid(),
    summary: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ExportStrategyChangeRequest = z.infer<typeof ExportStrategyChangeRequestSchema>;

export const PerformanceChannelQuerySchema = z
  .object({
    channelId: z.uuid(),
  })
  .strict();
export type PerformanceChannelQuery = z.infer<typeof PerformanceChannelQuerySchema>;
