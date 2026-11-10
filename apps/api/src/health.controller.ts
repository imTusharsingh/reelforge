import { Controller, Get } from "@nestjs/common";
import { OrchestrationService } from "./modules/orchestration/orchestration.service.js";
import type { WorkflowQueueHealth } from "./modules/orchestration/orchestration.types.js";

export type HealthResponse = Readonly<{
  status: "ok" | "degraded";
  queue: WorkflowQueueHealth;
}>;

@Controller("health")
export class HealthController {
  public constructor(private readonly orchestration: OrchestrationService) {}

  /** `degraded` when REDIS_URL is set but Redis cannot be reached; unset REDIS_URL is NOT_CONFIGURED. */
  @Get()
  public async getHealth(): Promise<HealthResponse> {
    const queue = await this.orchestration.queueHealth();
    return { status: queue === "UNREACHABLE" ? "degraded" : "ok", queue };
  }
}
