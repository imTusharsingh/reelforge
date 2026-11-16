import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { GenreController } from "./genre.controller.js";
import { GenreService } from "./genre.service.js";
/** @deprecated M03 required-genre choice removed in V1; optional legacy genres remain until T2 migration. See DEPRECATIONS.md. */
@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [GenreController],
  providers: [GenreService],
})
export class GenreModule {}
