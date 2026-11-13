import { BadRequestException } from "@nestjs/common";
import {
  MetricAggregateRequestSchema,
  LatestMetricSnapshotQuerySchema,
  MetricCollectionRequestSchema,
  type MetricCollectionRequest,
  type MetricAggregateRequest,
  type LatestMetricSnapshotQuery,
} from "@reelforge/contracts";
import { z } from "zod";

export type MetricAggregateQuery = MetricAggregateRequest;

export function parseMetricCollectionJobId(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new BadRequestException("Collection job ID must be a UUID");
  return parsed.data;
}

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

export function parseLatestMetricSnapshotQuery(value: unknown): LatestMetricSnapshotQuery {
  const parsed = LatestMetricSnapshotQuerySchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}
