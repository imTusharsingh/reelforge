import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { AuditModule } from "./audit.module.js";
import { EmergencyStopService } from "./emergency-stop.service.js";
import { EMERGENCY_STOP_PORT } from "./emergency-stop.types.js";

/**
 * Emergency stop state and check (M19-T06). Depends only on the database and the audit sink, so
 * M16, M18, and M13 can import it without a module cycle.
 */
@Module({
  imports: [IdentityModule, AuditModule],
  providers: [
    EmergencyStopService,
    { provide: EMERGENCY_STOP_PORT, useExisting: EmergencyStopService },
  ],
  exports: [EmergencyStopService, EMERGENCY_STOP_PORT],
})
export class EmergencyStopModule {}
