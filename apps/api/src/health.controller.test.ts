import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";
import type { OrchestrationService } from "./modules/orchestration/orchestration.service.js";
import type { WorkflowQueueHealth } from "./modules/orchestration/orchestration.types.js";

function controller(queue: WorkflowQueueHealth): HealthController {
  return new HealthController({
    queueHealth: async () => queue,
  } as unknown as OrchestrationService);
}

describe("HealthController", () => {
  it("reports the workflow queue status and degrades only when Redis is unreachable", async () => {
    await expect(controller("CONFIGURED").getHealth()).resolves.toEqual({
      status: "ok",
      queue: "CONFIGURED",
    });
    await expect(controller("NOT_CONFIGURED").getHealth()).resolves.toEqual({
      status: "ok",
      queue: "NOT_CONFIGURED",
    });
    await expect(controller("UNREACHABLE").getHealth()).resolves.toEqual({
      status: "degraded",
      queue: "UNREACHABLE",
    });
  });
});
