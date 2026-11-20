import { Module } from "@nestjs/common";
import { AssetModule } from "../asset/asset.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { CompositionService } from "./composition.service.js";
@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule],
  providers: [CompositionService],
  exports: [CompositionService],
})
export class CompositionModule {}
