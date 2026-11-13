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
import { OpenAiQualityReviewPort, openAiKey, openAiTextModel } from "../openai/openai.adapters.js";

class NotConfiguredQualityReviewPort implements QualityReviewPort {
  public review(request: QualityReviewRequest): Promise<QualityReviewResult> {
    throw new ProviderError(
      "NOT_CONFIGURED",
      "No real AI quality-review adapter is configured",
      request.correlationId,
    );
  }
}

@Module({
  imports: [IdentityModule, WorkspaceModule, CompositionModule, UsageBudgetModule],
  controllers: [QualityController],
  providers: [
    QualityService,
    {
      provide: QUALITY_REVIEW_PORT,
      useFactory: (): QualityReviewPort => {
        const key = openAiKey();
        return key === undefined
          ? new NotConfiguredQualityReviewPort()
          : new OpenAiQualityReviewPort(key, openAiTextModel());
      },
    },
  ],
  exports: [QualityService],
})
export class QualityModule {}
