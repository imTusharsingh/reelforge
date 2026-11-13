import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PublishingModule } from "../publishing/publishing.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { PerformanceIntelligenceController } from "./performance-intelligence.controller.js";
import { PerformanceIntelligenceService } from "./performance-intelligence.service.js";
import { INSIGHT_REPORT_LLM } from "./performance-intelligence.tokens.js";
import {
  NotConfiguredInsightReportLlm,
  type InsightReportLlmPort,
} from "./performance-intelligence.ports.js";
import { OpenAiInsightReportLlm, openAiRuntimeConfig } from "../openai/openai.adapters.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AnalyticsModule, PublishingModule, UsageBudgetModule],
  controllers: [PerformanceIntelligenceController],
  providers: [
    PerformanceIntelligenceService,
    {
      provide: INSIGHT_REPORT_LLM,
      useFactory: (): InsightReportLlmPort => {
        const config = openAiRuntimeConfig();
        return config.key === undefined
          ? new NotConfiguredInsightReportLlm()
          : new OpenAiInsightReportLlm(config.key, config.textModel);
      },
    },
  ],
  exports: [PerformanceIntelligenceService],
})
export class PerformanceIntelligenceModule {}
