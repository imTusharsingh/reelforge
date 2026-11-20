import { Module } from "@nestjs/common";
import {
  ProviderError,
  QUALITY_REVIEW_PORT,
  type QualityReviewPort,
  type QualityReviewRequest,
  type QualityReviewResult,
} from "@reelforge/ai-providers";
import { CompositionModule } from "../composition/composition.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";
import { CriticPipeline } from "./critic.pipeline.js";
import { MediaProbe } from "./media-probe.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";

const retiredQualityReviewPort: QualityReviewPort = {
  async review(request: QualityReviewRequest): Promise<QualityReviewResult> {
    throw new ProviderError(
      "NOT_CONFIGURED",
      "No real AI quality-review adapter is configured",
      request.correlationId,
    );
  },
};
@Module({
  imports: [IdentityModule, WorkspaceModule, CompositionModule],
  controllers: [QualityController],
  providers: [
    QualityService,
    CriticPipeline,
    MediaProbe,
    SpawnProcessRunner,
    { provide: QUALITY_REVIEW_PORT, useValue: retiredQualityReviewPort },
  ],
  exports: [QualityService, CriticPipeline, MediaProbe, QUALITY_REVIEW_PORT],
})
export class QualityModule {}
