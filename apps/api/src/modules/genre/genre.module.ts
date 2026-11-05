import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { GenreController } from "./genre.controller.js";
import { GenreService } from "./genre.service.js";
@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [GenreController],
  providers: [GenreService],
})
export class GenreModule {}
