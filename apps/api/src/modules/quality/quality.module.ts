import { Module } from "@nestjs/common";
import {
  ProviderError,
  QUALITY_REVIEW_PORT,
  type QualityReviewPort,
  type QualityReviewRequest,
  type QualityReviewResult,
} from "@reelforge/ai-providers";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { CompositionModule } from "../composition/composition.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";
import { OpenAiQualityReviewPort, openAiRuntimeConfig } from "../openai/openai.adapters.js";
import { V6QualityPipeline } from "./v6-quality.pipeline.js";

class NotConfiguredQualityReviewPort implements QualityReviewPort {
  public review(request: QualityReviewRequest): Promise<QualityReviewResult> {
    throw new ProviderError(
      "NOT_CONFIGURED",
      "No real AI quality-review adapter is configured",
      request.correlationId,
    );
  }
}

/** @deprecated M11 single-pass review replaced and deleted in V6; obsolete DB data removal waits for T2 ADR/migration. See DEPRECATIONS.md. */
@Module({
  imports: [IdentityModule, WorkspaceModule, CompositionModule, UsageBudgetModule],
  controllers: [QualityController],
  providers: [
    QualityService,
    V6QualityPipeline,
    {
      provide: QUALITY_REVIEW_PORT,
      useFactory: (): QualityReviewPort => {
        const config = openAiRuntimeConfig();
        return config.key === undefined || !config.textFallbackEnabled
          ? new NotConfiguredQualityReviewPort()
          : new OpenAiQualityReviewPort(config.key, config.textModel);
      },
    },
  ],
  exports: [QualityService, V6QualityPipeline],
})
export class QualityModule {}
