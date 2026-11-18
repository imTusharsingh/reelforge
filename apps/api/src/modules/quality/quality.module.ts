import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { QualityController } from "./quality.controller.js";
import { QualityService } from "./quality.service.js";
import { V6QualityPipeline } from "./v6-quality.pipeline.js";
import { V6MediaProbe } from "./v6-media-probe.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";

/** @deprecated M11 single-pass review replaced and deleted in V6; obsolete DB data removal waits for T2 ADR/migration. See DEPRECATIONS.md. */
@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [QualityController],
  providers: [QualityService, V6QualityPipeline, V6MediaProbe, SpawnProcessRunner],
  exports: [QualityService, V6QualityPipeline, V6MediaProbe],
})
export class QualityModule {}
