import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";
import { CriticPipeline } from "./critic.pipeline.js";
import { MediaProbe } from "./media-probe.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";

/** @deprecated M11 single-pass review replaced and deleted in V6; obsolete DB data removal waits for T2 ADR/migration. See DEPRECATIONS.md. */
@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [QualityController],
  providers: [QualityService, CriticPipeline, MediaProbe, SpawnProcessRunner],
  exports: [QualityService, CriticPipeline, MediaProbe],
})
export class QualityModule {}
