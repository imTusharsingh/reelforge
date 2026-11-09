import { Module } from "@nestjs/common";
import { AssetModule } from "../asset/asset.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { CompositionController } from "./composition.controller.js";
import { CompositionEngine, COMPOSITION_RUNNER, SpawnProcessRunner } from "./composition.engine.js";
import { CompositionService } from "./composition.service.js";
import { COMPOSITION_ENGINE } from "./composition.types.js";
@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule],
  controllers: [CompositionController],
  providers: [
    CompositionService,
    { provide: "COMPOSITION_CLOCK", useValue: { now: (): Date => new Date() } },
    CompositionEngine,
    SpawnProcessRunner,
    { provide: COMPOSITION_RUNNER, useExisting: SpawnProcessRunner },
    { provide: COMPOSITION_ENGINE, useExisting: CompositionEngine },
  ],
  exports: [CompositionService],
})
export class CompositionModule {}
