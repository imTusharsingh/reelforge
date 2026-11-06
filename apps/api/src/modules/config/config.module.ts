import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { ConfigController } from "./config.controller.js";
import { ConfigService } from "./config.service.js";
import { PromptController } from "./prompt.controller.js";
import { PromptService } from "./prompt.service.js";

@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [ConfigController, PromptController],
  providers: [ConfigService, PromptService],
  exports: [ConfigService, PromptService],
})
export class ConfigModule {}
