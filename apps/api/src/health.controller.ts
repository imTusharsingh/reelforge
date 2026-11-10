import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Database } from "./modules/identity/identity.types.js";
import { OrchestrationService } from "./modules/orchestration/orchestration.service.js";
import type { WorkflowQueueHealth } from "./modules/orchestration/orchestration.types.js";

export type DatabaseHealth = "OK" | "UNREACHABLE";

export type HealthResponse = Readonly<{
  status: "ok" | "degraded";
  queue: WorkflowQueueHealth;
  database: DatabaseHealth;
}>;

export type ProbeResponse = Readonly<{
  probe: "liveness" | "readiness";
  status: "ok" | "unavailable";
  database?: DatabaseHealth;
}>;

const DATABASE_TIMEOUT_MS = 2_000;

/**
 * `GET /health` (M16 surface, extended by M19-T04). Checks only Postgres (`SELECT 1`) and the
 * queue adapter (Redis ping when configured); it never calls an AI provider, social platform, or
 * storage service, so it cannot create provider calls or charges (ADR-007/010).
 * - No `probe`: full status, always HTTP 200 (unchanged contract plus `database`).
 * - `?probe=liveness`: process is up; no dependency checks.
 * - `?probe=readiness`: HTTP 503 when Postgres is unreachable. Redis is not a readiness gate
 *   because an unreachable queue degrades dispatch but Postgres stays the source of truth.
 */
@Controller("health")
export class HealthController {
  public constructor(
    private readonly orchestration: OrchestrationService,
    @Inject("DATABASE") private readonly db: Pick<Database, "$queryRaw">,
  ) {}

  @Get()
  public async getHealth(
    @Query("probe") probe?: string,
    @Res({ passthrough: true }) response?: Pick<Response, "status">,
  ): Promise<HealthResponse | ProbeResponse> {
    if (probe === "liveness") return { probe: "liveness", status: "ok" };
    if (probe === "readiness") {
      const database = await this.databaseHealth();
      if (database !== "OK") response?.status(503);
      return { probe: "readiness", status: database === "OK" ? "ok" : "unavailable", database };
    }
    const [queue, database] = await Promise.all([
      this.orchestration.queueHealth(),
      this.databaseHealth(),
    ]);
    return {
      status: queue === "UNREACHABLE" || database !== "OK" ? "degraded" : "ok",
      queue,
      database,
    };
  }

  private async databaseHealth(): Promise<DatabaseHealth> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database health timeout")), DATABASE_TIMEOUT_MS);
      });
      await Promise.race([this.db.$queryRaw`SELECT 1`, timeout]);
      return "OK";
    } catch {
      return "UNREACHABLE";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
