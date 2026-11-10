import {
  createContext,
  currentContext,
  newSpanId,
  runWithContext,
  type ObservabilityContext,
} from "./context.js";
import { redact } from "./redaction.js";

/**
 * Minimal tracing (M19-T03). Spans carry W3C trace/span ids and OpenTelemetry field names
 * (`trace_id`, `span_id`, `parent_span_id`, `name`, `kind`, `start_time_unix_nano`,
 * `end_time_unix_nano`, `status`, `attributes`). Finished spans go to a pluggable exporter; the
 * default exporter drops them. A real OTel SDK exporter needs an ADR-012 dependency pin (not
 * added in M19).
 */
export type SpanStatus = "OK" | "ERROR" | "UNSET";
export type SpanKind = "SERVER" | "CLIENT" | "INTERNAL" | "CONSUMER";

export type FinishedSpan = Readonly<{
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  duration_ms: number;
  status: SpanStatus;
  attributes: Readonly<Record<string, unknown>>;
  correlation_id: string;
}>;

export type SpanExporter = (span: FinishedSpan) => void;

let exporter: SpanExporter = () => undefined;

export function setSpanExporter(next: SpanExporter | null): void {
  exporter = next ?? ((): void => undefined);
}

export class Span {
  private ended = false;
  private readonly startedAt = process.hrtime.bigint();
  private readonly startedWall = BigInt(Date.now()) * 1_000_000n;
  private readonly attributes: Record<string, unknown> = {};

  public constructor(
    public readonly name: string,
    public readonly context: ObservabilityContext,
    public readonly kind: SpanKind = "INTERNAL",
  ) {}

  public setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  public end(status: SpanStatus = "OK"): FinishedSpan | null {
    if (this.ended) return null;
    this.ended = true;
    const elapsed = process.hrtime.bigint() - this.startedAt;
    const finished: FinishedSpan = {
      trace_id: this.context.traceId,
      span_id: this.context.spanId,
      parent_span_id: this.context.parentSpanId ?? null,
      name: this.name,
      kind: this.kind,
      start_time_unix_nano: this.startedWall.toString(),
      end_time_unix_nano: (this.startedWall + elapsed).toString(),
      duration_ms: Number(elapsed / 1_000n) / 1_000,
      status,
      attributes: redact(this.attributes) as Record<string, unknown>,
      correlation_id: this.context.correlationId,
    };
    try {
      exporter(finished);
    } catch {
      // An exporter failure must never break the traced work.
    }
    return finished;
  }
}

/** Starts a child span of the active context (or a new trace when there is none). */
export function startSpan(name: string, kind: SpanKind = "INTERNAL"): Span {
  const parent = currentContext();
  const context: ObservabilityContext = parent
    ? { ...parent, parentSpanId: parent.spanId, spanId: newSpanId() }
    : createContext();
  return new Span(name, context, kind);
}

/** Runs `fn` inside a child span; the span ends with ERROR when `fn` throws or rejects. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  kind: SpanKind = "INTERNAL",
): Promise<T> {
  const span = startSpan(name, kind);
  return runWithContext(span.context, async () => {
    try {
      const result = await fn(span);
      span.end("OK");
      return result;
    } catch (error) {
      span.setAttribute("error", error);
      span.end("ERROR");
      throw error;
    }
  });
}
