import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Request/job context (M19-T03). Correlation ids reuse the existing scheme: a UUID, as already
 * stored by M08 (`provider_requests.correlation_id`) and M16 (`workflow_runs.correlation_id`). An
 * inbound `x-correlation-id` that is not a UUID is ignored and a fresh UUID is used.
 * Trace ids follow W3C Trace Context (`traceparent`), so an OpenTelemetry collector can join them.
 */
export type ObservabilityContext = Readonly<{
  correlationId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  workspaceId?: string;
}>;

const storage = new AsyncLocalStorage<ObservabilityContext>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Accepts an inbound correlation id only when it is a UUID; otherwise mints one. */
export function normalizeCorrelationId(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isUuid(candidate) ? candidate.toLowerCase() : randomUUID();
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Parses a W3C `traceparent` header; returns null when it is missing or malformed. */
export function parseTraceparent(
  value: unknown,
): Readonly<{ traceId: string; parentSpanId: string }> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return null;
  const match = TRACEPARENT_PATTERN.exec(candidate.trim().toLowerCase());
  if (!match || /^0+$/.test(match[1] ?? "") || /^0+$/.test(match[2] ?? "")) return null;
  return { traceId: match[1] as string, parentSpanId: match[2] as string };
}

export function formatTraceparent(
  context: Pick<ObservabilityContext, "traceId" | "spanId">,
): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}

/** Builds a root context for an inbound request or a background job. */
export function createContext(
  input: Readonly<{ correlationId?: unknown; traceparent?: unknown; workspaceId?: string }> = {},
): ObservabilityContext {
  const parent = parseTraceparent(input.traceparent);
  return {
    correlationId: normalizeCorrelationId(input.correlationId),
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    ...(parent ? { parentSpanId: parent.parentSpanId } : {}),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
}

export function runWithContext<T>(context: ObservabilityContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): ObservabilityContext | undefined {
  return storage.getStore();
}

/** The active correlation id, or a new UUID when called outside any context. */
export function currentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}
