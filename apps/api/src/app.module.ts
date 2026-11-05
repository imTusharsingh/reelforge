import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";

@Module({ imports: [IdentityModule, WorkspaceModule], controllers: [HealthController] })
export class AppModule {}
