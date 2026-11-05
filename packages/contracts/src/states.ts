import { z } from "zod";

export const PublishStatusSchema = z.enum([
  "DRAFT",
  "SCHEDULED",
  "PREFLIGHT",
  "UPLOADING",
  "REMOTE_PROCESSING",
  "PUBLISHED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELED",
  "RECONCILIATION_REQUIRED",
]);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const WorkflowStateSchema = z.enum([
  "CREATED",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "SUCCEEDED",
  "PAUSED",
  "RETRY_WAIT",
  "FAILED",
  "CANCELED",
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
