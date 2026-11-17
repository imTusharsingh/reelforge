import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { SceneMediaController } from "./scene-media.controller.js";
import { SceneMediaService } from "./scene-media.service.js";
/** @deprecated Legacy history and C3 assignment only; removed in T2. V5 removed synchronous media production and its provider bindings. */
@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [SceneMediaController],
  providers: [SceneMediaService],
  exports: [SceneMediaService],
})
export class SceneMediaModule {}
