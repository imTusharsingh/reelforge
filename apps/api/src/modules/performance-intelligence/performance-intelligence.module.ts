import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PublishingModule } from "../publishing/publishing.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { PerformanceIntelligenceController } from "./performance-intelligence.controller.js";
import { PerformanceIntelligenceService } from "./performance-intelligence.service.js";
import { INSIGHT_REPORT_LLM } from "./performance-intelligence.tokens.js";
import { NotConfiguredInsightReportLlm } from "./performance-intelligence.ports.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AnalyticsModule, PublishingModule, UsageBudgetModule],
  controllers: [PerformanceIntelligenceController],
  providers: [
    PerformanceIntelligenceService,
    {
      provide: INSIGHT_REPORT_LLM,
      useClass: NotConfiguredInsightReportLlm,
    },
  ],
  exports: [PerformanceIntelligenceService],
})
export class PerformanceIntelligenceModule {}
