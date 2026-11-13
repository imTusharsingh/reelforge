import { BadRequestException } from "@nestjs/common";
import {
  CreateExperimentRequestSchema,
  ExportStrategyChangeRequestSchema,
  GenerateInsightReportRequestSchema,
  GenerateRecommendationsRequestSchema,
  PerformanceChannelQuerySchema,
  RecordExperimentOutcomeRequestSchema,
  type CreateExperimentRequest,
  type ExportStrategyChangeRequest,
  type GenerateRecommendationsRequest,
  type PerformanceChannelQuery,
  type RecordExperimentOutcomeRequest,
} from "@reelforge/contracts";
import { z } from "zod";

const generateInsightReportRequestSchema = GenerateInsightReportRequestSchema.extend({
  correlationId: z.uuid().optional(),
});
export type GenerateInsightReportInput = z.infer<typeof generateInsightReportRequestSchema>;

export function parseGenerateInsightReportRequest(value: unknown): GenerateInsightReportInput {
  const parsed = generateInsightReportRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseGenerateRecommendationsRequest(
  value: unknown,
): GenerateRecommendationsRequest {
  const parsed = GenerateRecommendationsRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseCreateExperimentRequest(value: unknown): CreateExperimentRequest {
  const parsed = CreateExperimentRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseRecordExperimentOutcomeRequest(
  value: unknown,
): RecordExperimentOutcomeRequest {
  const parsed = RecordExperimentOutcomeRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseExportStrategyChangeRequest(value: unknown): ExportStrategyChangeRequest {
  const parsed = ExportStrategyChangeRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parsePerformanceChannelQuery(value: unknown): PerformanceChannelQuery {
  const parsed = PerformanceChannelQuerySchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parsePerformanceId(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException("ID must be a UUID");
  return parsed.data;
}
