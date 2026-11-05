import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { ChannelController } from "./channel.controller.js";
import { ChannelService } from "./channel.service.js";

@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [ChannelController],
  providers: [ChannelService],
  exports: [ChannelService],
})
export class ChannelModule {}
