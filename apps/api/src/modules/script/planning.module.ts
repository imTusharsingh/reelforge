import { PlanningCharacterService } from "../character/planning-character.service.js";
import { PlanningService } from "./planning.service.js";
import { ArtDirectorService } from "../character/art-director.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { AssetModule } from "../asset/asset.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { ReferenceLibraryModule } from "../reference-library/reference-library.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import {
  PLANNING_TEXT,
  PLANNING_IMAGES,
  UnconfiguredTextPort,
  UnconfiguredImageGenPort,
} from "../reference-library/planning.ports.js";
import { DirectorService, ScriptwriterService } from "./planning-agents.js";
@Module({
  imports: [ConfigModule, IdentityModule, ReferenceLibraryModule, AssetModule],
  providers: [
    PlanningPromptService,
    PlanningService,
    ArtDirectorService,
    PlanningCharacterService,
    PlanningReferenceAssetsService,
    ScriptwriterService,
    DirectorService,
    { provide: PLANNING_TEXT, useClass: UnconfiguredTextPort },
    { provide: PLANNING_IMAGES, useClass: UnconfiguredImageGenPort },
  ],
  exports: [ScriptwriterService, DirectorService, ArtDirectorService, PlanningService],
})
export class PlanningModule {}
