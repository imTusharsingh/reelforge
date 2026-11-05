import { describe, expect, it } from "vitest";
import { PublishStatusSchema, WorkflowStateSchema } from "./states.js";

describe("canonical state contracts", () => {
  it("accepts all publish states defined by the pipeline", () => {
    expect(PublishStatusSchema.options).toEqual([
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
  });

  it("accepts all workflow states defined by the pipeline", () => {
    expect(WorkflowStateSchema.options).toEqual([
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
  });

  it("rejects states outside the canonical vocabularies", () => {
    expect(PublishStatusSchema.safeParse("PUBLISHING").success).toBe(false);
    expect(WorkflowStateSchema.safeParse("WAITING").success).toBe(false);
  });
});
