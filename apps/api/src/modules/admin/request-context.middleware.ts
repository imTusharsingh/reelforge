import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  createContext,
  formatTraceparent,
  metrics,
  runWithContext,
  StructuredLogger,
  parseLogLevel,
  type ObservabilityContext,
} from "@reelforge/observability";
import { stripGlobalPrefix } from "./audit.catalog.js";

const httpRequests = metrics.counter(
  "reelforge_http_requests_total",
  "HTTP requests by route and status",
);
const httpDuration = metrics.histogram(
  "reelforge_http_request_duration_ms",
  "HTTP request duration in milliseconds",
);

export type ObservedRequest = Request & {
  observability?: ObservabilityContext;
  principal?: { userId: string };
};

/** Route template only (never the raw URL: query strings can carry OAuth codes or tokens). */
export function routeTemplate(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route?.path;
  const base = typeof request.baseUrl === "string" ? request.baseUrl : "";
  if (typeof route === "string") return stripGlobalPrefix(`${base}${route}`);
  return "unmatched";
}

/**
 * M19-T03 request context: accepts a UUID `x-correlation-id` (else mints one, same scheme as
 * M08/M16) and a W3C `traceparent`, echoes both on the response, runs the request inside the
 * async context so logs and audit events carry the ids, and records an access log line plus
 * request count/latency metrics. Logs the route template, never the URL, body, or headers.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new StructuredLogger({
    service: "api",
    level: parseLogLevel(process.env["LOG_LEVEL"]),
  });

  public use(request: ObservedRequest, response: Response, next: NextFunction): void {
    const context = createContext({
      correlationId: request.headers["x-correlation-id"],
      traceparent: request.headers["traceparent"],
    });
    request.observability = context;
    response.setHeader("x-correlation-id", context.correlationId);
    response.setHeader("traceparent", formatTraceparent(context));
    const started = process.hrtime.bigint();
    response.on("finish", () => {
      const durationMs = Number((process.hrtime.bigint() - started) / 1_000n) / 1_000;
      const route = routeTemplate(request);
      const labels = { method: request.method, route, status: response.statusCode };
      httpRequests.inc(labels);
      httpDuration.observe({ method: request.method, route }, durationMs);
      if (route === "/health" && response.statusCode < 400) return;
      runWithContext(context, () =>
        this.logger.info("http request", {
          method: request.method,
          route,
          status: response.statusCode,
          durationMs,
          userId: request.principal?.userId ?? null,
        }),
      );
    });
    runWithContext(context, () => next());
  }
}
