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
import { CompositionModule } from "../composition/composition.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";

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
  imports: [IdentityModule, WorkspaceModule, CompositionModule],
  controllers: [QualityController],
  providers: [
    QualityService,
    { provide: QUALITY_REVIEW_PORT, useClass: NotConfiguredQualityReviewPort },
  ],
  exports: [QualityService],
})
export class QualityModule {}
