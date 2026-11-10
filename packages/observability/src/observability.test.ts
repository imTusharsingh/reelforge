import { afterEach, describe, expect, it } from "vitest";
import {
  FrameworkLoggerAdapter,
  MetricsRegistry,
  REDACTED,
  StructuredLogger,
  clearRegisteredSecrets,
  createContext,
  formatTraceparent,
  installConsoleRedaction,
  normalizeCorrelationId,
  parseTraceparent,
  redact,
  redactString,
  registerSecretEnv,
  runWithContext,
  setSpanExporter,
  startSpan,
  withSpan,
  type FinishedSpan,
} from "./index.js";

const SIGNED_URL =
  "https://media-bucket.s3.amazonaws.com/workspaces/w1/renders/r1/final.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261110&X-Amz-Signature=deadbeefcafebabe";
const UPLOAD_SESSION =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=ADPycdu-SECRETSESSION";

function capture(): { lines: string[]; logger: StructuredLogger } {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    service: "test",
    level: "debug",
    sink: (line): void => {
      lines.push(line);
    },
    clock: (): Date => new Date("2026-11-10T00:00:00.000Z"),
  });
  return { lines, logger };
}

afterEach(() => {
  clearRegisteredSecrets();
  setSpanExporter(null);
});

describe("redaction (M19-T03)", () => {
  it("drops secret-named fields whole", () => {
    const out = redact({
      password: "hunter2-hunter2",
      accessToken: "abc",
      refresh_token: "def",
      Authorization: "Bearer xyz",
      cookie: "reelforge_session=abc",
      apiKey: "k",
      clientSecret: "s",
      sessionCiphertext: "v1:...",
      sessionUri: UPLOAD_SESSION,
      storageKey: "workspaces/w1/renders/r1/final.mp4",
      nested: { tokens: { access: "a" }, ok: 1 },
      idempotencyKey: "manual:1",
      correlationId: "c0a8012e-1111-4222-8333-444455556666",
    }) as Record<string, unknown>;
    for (const key of [
      "password",
      "accessToken",
      "refresh_token",
      "Authorization",
      "cookie",
      "apiKey",
      "clientSecret",
      "sessionCiphertext",
      "sessionUri",
      "storageKey",
    ])
      expect(out[key]).toBe(REDACTED);
    expect(out["nested"]).toEqual({ tokens: REDACTED, ok: 1 });
    expect(out["idempotencyKey"]).toBe("manual:1");
    expect(out["correlationId"]).toBe("c0a8012e-1111-4222-8333-444455556666");
  });

  it("strips private media URLs and upload sessions down to scheme and host", () => {
    const text = redactString(`render ready at ${SIGNED_URL} and session ${UPLOAD_SESSION}`);
    expect(text).toBe(
      `render ready at https://media-bucket.s3.amazonaws.com/${REDACTED} and session https://www.googleapis.com/${REDACTED}`,
    );
    expect(text).not.toContain("X-Amz-Signature");
    expect(text).not.toContain("SECRETSESSION");
    expect(text).not.toContain("final.mp4");
  });

  it("removes credentials from connection strings and masks tokens in free text", () => {
    const text = redactString(
      "db postgresql://postgres:s3cr3t@127.0.0.1:55437/reelforge?schema=public; auth Bearer abcdef123456; jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U; google ya29.a0AfH6SMBexampletoken and 1//0gLongRefreshToken; client_secret=shh&x=1 password=pw",
    );
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("eyJhbGci");
    expect(text).not.toContain("ya29.");
    expect(text).not.toContain("1//0g");
    expect(text).not.toContain("shh");
    expect(text).not.toMatch(/password=pw/);
    expect(text).toContain(`postgresql://127.0.0.1:55437/${REDACTED}`);
  });

  it("masks registered secret env values wherever they appear", () => {
    registerSecretEnv({
      PUBLISH_SESSION_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      NODE_ENV: "production-mode",
    });
    expect(redactString("key=0123456789abcdef0123456789abcdef!")).not.toContain("0123456789abcdef");
    expect(redactString("env production-mode")).toBe("env production-mode");
  });

  it("serializes errors, buffers, cycles, and bigints safely", () => {
    const error = Object.assign(new Error(`upload failed for ${SIGNED_URL}`), { code: "E_UPLOAD" });
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    const out = redact({ error, buffer: Buffer.from("secret media"), cyclic, big: 10n }) as Record<
      string,
      Record<string, unknown> | string
    >;
    const serialized = out["error"] as Record<string, unknown>;
    expect(serialized["code"]).toBe("E_UPLOAD");
    expect(String(serialized["message"])).not.toContain("X-Amz");
    expect(String(serialized["stack"])).not.toContain("X-Amz");
    expect(out["buffer"]).toBe("[Buffer length=12]");
    expect((out["cyclic"] as Record<string, unknown>)["self"]).toBe("[Circular]");
    expect(out["big"]).toBe("10");
  });
});

describe("structured logger and console redaction", () => {
  it("writes one JSON line with correlation and trace ids from the active context", () => {
    const { lines, logger } = capture();
    const context = createContext({ correlationId: "6f1c2a4e-0b7d-4c55-9f00-1a2b3c4d5e6f" });
    runWithContext(context, () =>
      logger.info(`publish ${UPLOAD_SESSION}`, { token: "t", attempt: 2 }),
    );
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      ts: "2026-11-10T00:00:00.000Z",
      level: "info",
      service: "test",
      correlationId: "6f1c2a4e-0b7d-4c55-9f00-1a2b3c4d5e6f",
      traceId: context.traceId,
      spanId: context.spanId,
      token: REDACTED,
      attempt: 2,
    });
    expect(String(entry["msg"])).not.toContain("upload_id");
  });

  it("routes console.* through redaction and restores it", () => {
    const { lines, logger } = capture();
    const target = { ...console } as Console;
    const restore = installConsoleRedaction(logger, target);
    target.error("[orchestration] enqueue failed", new Error(`at ${SIGNED_URL}`), {
      refreshToken: "r",
    });
    restore();
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry["level"]).toBe("error");
    expect(entry["msg"]).toBe("[orchestration] enqueue failed");
    expect(JSON.stringify(entry)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(entry)).not.toContain('"r"');
    expect(target.error).toBe(console.error);
  });

  it("adapts the Nest logger shape and keeps the component name", () => {
    const { lines, logger } = capture();
    new FrameworkLoggerAdapter(logger).warn("token=abc leaked?", "SocialAccountsService");
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "warn", component: "SocialAccountsService" });
    expect(entry["msg"]).toBe(`token=${REDACTED} leaked?`);
  });
});

describe("correlation ids and tracing", () => {
  it("accepts only UUID correlation ids (the existing M08/M16 scheme)", () => {
    expect(normalizeCorrelationId("6F1C2A4E-0B7D-4C55-9F00-1A2B3C4D5E6F")).toBe(
      "6f1c2a4e-0b7d-4c55-9f00-1a2b3c4d5e6f",
    );
    const minted = normalizeCorrelationId("not-a-uuid'; DROP TABLE");
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("continues a W3C traceparent and exports finished child spans", async () => {
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceparent(parent)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
    });
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    const exported: FinishedSpan[] = [];
    setSpanExporter((span) => exported.push(span));
    const root = createContext({ traceparent: parent });
    await runWithContext(root, () =>
      withSpan("db.query", (span) => {
        span.setAttribute("url", SIGNED_URL);
        return Promise.resolve(1);
      }),
    );
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_span_id: root.spanId,
      name: "db.query",
      status: "OK",
    });
    expect(JSON.stringify(exported[0])).not.toContain("X-Amz");
    expect(formatTraceparent(root)).toBe(`00-${root.traceId}-${root.spanId}-01`);
    const orphan = startSpan("orphan");
    expect(orphan.context.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("metrics registry", () => {
  it("renders counters, gauges, and histograms in Prometheus text format with safe labels", () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter("http_requests_total", "HTTP requests");
    requests.inc({ method: "GET", route: "/health", status: 200 });
    requests.inc({ method: "GET", route: "/health", status: 200 });
    requests.inc({ method: "POST", route: SIGNED_URL, status: 500 });
    registry.gauge("queue_depth", "Queue depth").set({ queue: "reelforge-orchestration" }, 3);
    registry
      .histogram("http_request_duration_ms", "Latency", [10, 100])
      .observe({ route: "/x" }, 42);
    const text = registry.render();
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain('http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(text).toContain('queue_depth{queue="reelforge-orchestration"} 3');
    expect(text).toContain('http_request_duration_ms_bucket{le="10",route="/x"} 0');
    expect(text).toContain('http_request_duration_ms_bucket{le="100",route="/x"} 1');
    expect(text).toContain('http_request_duration_ms_count{route="/x"} 1');
    expect(text).not.toContain("X-Amz-Signature");
    expect(() => registry.gauge("http_requests_total", "dup")).toThrow();
  });
});
