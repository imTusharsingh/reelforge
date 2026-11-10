import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller.js";
import type { OrchestrationService } from "./modules/orchestration/orchestration.service.js";
import type { WorkflowQueueHealth } from "./modules/orchestration/orchestration.types.js";

function controller(
  queue: WorkflowQueueHealth,
  database: "up" | "down" = "up",
): { health: HealthController; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => {
    if (database === "down") throw new Error("connection refused");
    return [{ "?column?": 1 }];
  });
  const health = new HealthController(
    { queueHealth: async () => queue } as unknown as OrchestrationService,
    { $queryRaw: query } as never,
  );
  return { health, query };
}

describe("HealthController", () => {
  it("reports the workflow queue status and degrades only when Redis is unreachable", async () => {
    await expect(controller("CONFIGURED").health.getHealth()).resolves.toEqual({
      status: "ok",
      queue: "CONFIGURED",
      database: "OK",
    });
    await expect(controller("NOT_CONFIGURED").health.getHealth()).resolves.toEqual({
      status: "ok",
      queue: "NOT_CONFIGURED",
      database: "OK",
    });
    await expect(controller("UNREACHABLE").health.getHealth()).resolves.toEqual({
      status: "degraded",
      queue: "UNREACHABLE",
      database: "OK",
    });
  });

  it("degrades when Postgres is unreachable and fails readiness with 503 (M19-T04)", async () => {
    await expect(controller("CONFIGURED", "down").health.getHealth()).resolves.toEqual({
      status: "degraded",
      queue: "CONFIGURED",
      database: "UNREACHABLE",
    });
    const status = vi.fn();
    await expect(
      controller("CONFIGURED", "down").health.getHealth("readiness", { status } as never),
    ).resolves.toEqual({ probe: "readiness", status: "unavailable", database: "UNREACHABLE" });
    expect(status).toHaveBeenCalledWith(503);
    const ready = vi.fn();
    await expect(
      controller("UNREACHABLE").health.getHealth("readiness", { status: ready } as never),
    ).resolves.toEqual({ probe: "readiness", status: "ok", database: "OK" });
    expect(ready).not.toHaveBeenCalled();
  });

  it("answers liveness without touching any dependency", async () => {
    const queueHealth = vi.fn();
    const query = vi.fn();
    const health = new HealthController(
      { queueHealth } as unknown as OrchestrationService,
      { $queryRaw: query } as never,
    );
    await expect(health.getHealth("liveness")).resolves.toEqual({
      probe: "liveness",
      status: "ok",
    });
    expect(queueHealth).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
