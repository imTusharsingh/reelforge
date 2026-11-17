import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { EmergencyStopModule } from "../admin/emergency-stop.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { RunNotifications } from "../notifications/run-notifications.js";
import { RunsStore } from "../runs/runs.store.js";
import { AutonomyService } from "./autonomy.service.js";
import { AutonomyController } from "./autonomy.controller.js";
@Module({
  imports: [IdentityModule, WorkspaceModule, EmergencyStopModule, NotificationsModule],
  controllers: [AutonomyController],
  providers: [
    RunsStore,
    AutonomyService,
    RunNotifications,
    { provide: "V8_RUNTIME", useExisting: RunNotifications },
  ],
  exports: ["V8_RUNTIME"],
})
export class AutonomyModule {}
