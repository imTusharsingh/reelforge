import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { AssetModule } from "../asset/asset.module.js";
import { CharacterController } from "./character.controller.js";
import { CharacterService } from "./character.service.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule],
  controllers: [CharacterController],
  providers: [CharacterService],
  exports: [CharacterService],
})
export class CharacterModule {}
