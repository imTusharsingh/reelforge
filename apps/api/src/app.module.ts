import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import { ChannelModule } from "./modules/channel/channel.module.js";
import { GenreModule } from "./modules/genre/genre.module.js";
import { AssetModule } from "./modules/asset/asset.module.js";
import { CharacterModule } from "./modules/character/character.module.js";
import { ConfigModule } from "./modules/config/config.module.js";
import { IdeaModule } from "./modules/idea/idea.module.js";

@Module({
  imports: [
    IdentityModule,
    WorkspaceModule,
    ChannelModule,
    GenreModule,
    AssetModule,
    CharacterModule,
    ConfigModule,
    IdeaModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
