import { Controller, Get, Header, Headers, NotFoundException, Res } from "@nestjs/common";
import type { Response } from "express";
import { metrics, secretsEqual } from "@reelforge/observability";

/**
 * M19-T03 process metrics in Prometheus text format, for an operator's scraper. Disabled (404)
 * unless `OPS_METRICS_TOKEN` is set; then it requires `Authorization: Bearer <token>` and still
 * answers 404 on a mismatch so the route is not discoverable. Metrics carry no tenant data: only
 * route templates, methods, statuses, and audit category counts.
 */
@Controller("ops")
export class OpsMetricsController {
  @Get("metrics")
  @Header("Cache-Control", "no-store")
  public metrics(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const token = process.env["OPS_METRICS_TOKEN"];
    if (token === undefined || token.length < 16) throw new NotFoundException();
    const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!secretsEqual(presented, token)) throw new NotFoundException();
    // Set only on success so the 404 stays a normal JSON error response.
    response.type("text/plain; version=0.0.4; charset=utf-8");
    return metrics.render();
  }
}
