import type { Tenant } from "../runs/runs.fixture.js";
import type { Json, Step } from "../runs/runs.types.js";

type Backing = {
  code?: string;
  expired?: boolean;
  committed?: boolean;
  cancelled?: boolean;
  detached?: boolean;
  metadata?: Json;
  output?: Json;
  providerJobId?: string;
};
export async function legacy(t: Tenant, key: string, options: Backing = {}): Promise<Step> {
  const { workspaceId, channelId, id: runId } = t.run;
  const dispatchKey = `${runId}:legacy:${key}`;
  const status = options.committed ? "COMMITTED" : options.expired ? "EXPIRED" : "RESERVED";
  const step = await t.db.videoRunStep.create({
    data: {
      workspaceId,
      runId,
      key: `media:text:${key}`,
      idempotencyKey: dispatchKey,
      state: options.cancelled ? "CANCELLED" : options.output ? "SUCCEEDED" : "RUNNING",
      input: { modelId: "fixture-text" },
      costMinor: 7,
      providerId: "gemini",
      ...(options.output && { output: options.output }),
      providerJobId: options.providerJobId ?? null,
    },
  });
  await t.db.providerRequest.create({
    data: {
      workspaceId,
      channelId,
      correlationId: step.id,
      providerId: "gemini",
      capabilityId: "fixture-text",
      status: options.output ? "SUCCEEDED" : "FAILED",
      currency: "USD",
      estimatedCost: "0.07",
      ...(options.cancelled && { actualCost: 0 }),
      errorCode: options.output ? null : (options.code ?? "VIDEO_RUN_DISPATCHING"),
      responseMetadata:
        options.metadata ??
        (options.cancelled
          ? { dispatched: false, costKnown: true, dispatchKey, stepId: step.id }
          : { dispatched: true, costKnown: false }),
    },
  });
  await t.db.usageReservation.create({
    data: {
      workspaceId,
      channelId,
      correlationId: options.detached ? null : step.id,
      idempotencyKey: `m08:${dispatchKey}`,
      category: "LLM",
      currency: "USD",
      amountMinor: 7n,
      status,
      expiresAt: new Date(options.expired ? "2026-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"),
      ...(options.committed && { committedMinor: 7n, committedAt: new Date() }),
    },
  });
  return step;
}
