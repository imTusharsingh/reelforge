import { BadRequestException } from "@nestjs/common";
import {
  MetricAggregateRequestSchema,
  MetricCollectionRequestSchema,
  type MetricCollectionRequest,
  type MetricAggregateRequest,
} from "@reelforge/contracts";

export type MetricAggregateQuery = MetricAggregateRequest;

export function parseMetricCollectionRequest(value: unknown): MetricCollectionRequest {
  const parsed = MetricCollectionRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseMetricAggregateQuery(value: unknown): MetricAggregateQuery {
  const parsed = MetricAggregateRequestSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}
