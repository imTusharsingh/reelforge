import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceService } from "./workspace.service.js";
import { WorkspaceController } from "./workspace.controller.js";
import { WorkspaceRepository } from "./workspace.repository.js";

@Module({
  imports: [IdentityModule],
  controllers: [WorkspaceController],
  providers: [
    WorkspaceService,
    {
      provide: WorkspaceRepository,
      useFactory: (db: ConstructorParameters<typeof WorkspaceRepository>[0]): WorkspaceRepository =>
        new WorkspaceRepository(db),
      inject: ["DATABASE"],
    },
  ],
  exports: [WorkspaceService, WorkspaceRepository],
})
export class WorkspaceModule {}
