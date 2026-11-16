import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { Module, RequestMethod } from "@nestjs/common";
import type { MiddlewareConsumer } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { AssetModule } from "../asset/asset.module.js";
import { EmergencyStopModule } from "../admin/emergency-stop.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunFallback } from "../orchestration/video-run.fallback.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { VideoRunEngine } from "../orchestration/video-run.engine.js";
import { legacyGenerationGate } from "../orchestration/video-run.legacy.js";
import { RunsStore } from "./runs.store.js";
import { RunsService } from "./runs.service.js";
import { RunsBoundary } from "./runs.boundary.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import { RunsControl } from "./runs.control.js";
import { RunsController } from "./runs.controller.js";
import { RunsQueue } from "./runs.queue.js";
import { RunsEvents } from "./runs.events.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule, EmergencyStopModule, UsageBudgetModule],
  controllers: [RunsController],
  providers: [
    RunsStore,
    RunsService,
    RunsBoundary,
    RunsArtifacts,
    RunsControl,
    RunPaidCalls,
    RunOutputs,
    RunGeneration,
    RunFallback,
    RunPlanning,
    VideoRunEngine,
    { provide: "VIDEO_RUN_RUNTIME", useExisting: VideoRunEngine },
  ],
  exports: ["VIDEO_RUN_RUNTIME"],
})
export class RunsModule {
  public constructor(private readonly runs: RunsService) {}
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(legacyGenerationGate).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
  public onModuleInit(): void {
    const url = process.env.REDIS_URL?.trim();
    if (url) {
      this.runs.queue = new RunsQueue(url);
      this.runs.events = new RunsEvents(this.runs.store, url);
    }
  }
  public async onModuleDestroy(): Promise<void> {
    await Promise.all([this.runs.queue?.close(), this.runs.events?.close()]);
  }
}
