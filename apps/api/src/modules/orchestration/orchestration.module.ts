import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { ChannelModule } from "../channel/channel.module.js";
import { CompositionModule } from "../composition/composition.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { IdeaModule } from "../idea/idea.module.js";
import { PublishingModule } from "../publishing/publishing.module.js";
import { QualityModule } from "../quality/quality.module.js";
import { SceneMediaModule } from "../scene-media/scene-media.module.js";
import { ScriptModule } from "../script/script.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { UnconfiguredBudgetPolicy } from "./orchestration.budget.js";
import { createWorkflowQueueFromEnv } from "./orchestration.bullmq.js";
import { OrchestrationController } from "./orchestration.controller.js";
import { WorkflowDomainDispatcher } from "./orchestration.dispatcher.js";
import { WorkflowLimitsService } from "./orchestration.limits.js";
import { OrchestrationService } from "./orchestration.service.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  ORCHESTRATION_CLOCK,
  WORKFLOW_BUDGET_POLICY,
  WORKFLOW_LIMIT_CONFIG,
  WORKFLOW_QUEUE_PORT,
  WORKFLOW_STEP_DISPATCHER,
  type WorkflowQueuePort,
} from "./orchestration.types.js";

@Module({
  imports: [
    IdentityModule,
    WorkspaceModule,
    ChannelModule,
    IdeaModule,
    ScriptModule,
    SceneMediaModule,
    CompositionModule,
    QualityModule,
    PublishingModule,
    AnalyticsModule,
  ],
  controllers: [OrchestrationController],
  providers: [
    WorkflowLimitsService,
    WorkflowDomainDispatcher,
    OrchestrationService,
    {
      provide: WORKFLOW_QUEUE_PORT,
      useFactory: (): WorkflowQueuePort => createWorkflowQueueFromEnv(process.env),
    },
    { provide: WORKFLOW_BUDGET_POLICY, useClass: UnconfiguredBudgetPolicy },
    { provide: WORKFLOW_STEP_DISPATCHER, useExisting: WorkflowDomainDispatcher },
    { provide: ORCHESTRATION_CLOCK, useValue: (): Date => new Date() },
    { provide: WORKFLOW_LIMIT_CONFIG, useValue: DEFAULT_WORKFLOW_LIMIT_CONFIG },
  ],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
