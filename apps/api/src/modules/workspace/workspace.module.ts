import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceService } from "./workspace.service.js";
import { WorkspaceController } from "./workspace.controller.js";

@Module({ imports: [IdentityModule], controllers: [WorkspaceController], providers: [WorkspaceService], exports: [WorkspaceService] })
export class WorkspaceModule {}
