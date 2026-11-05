import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import { ChannelModule } from "./modules/channel/channel.module.js";
import { GenreModule } from "./modules/genre/genre.module.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, ChannelModule, GenreModule],
  controllers: [HealthController],
})
export class AppModule {}
