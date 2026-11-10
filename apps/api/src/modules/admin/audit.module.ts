import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { AuditService } from "./audit.service.js";

/** Shared append-only audit sink (M19-T02). Import it to write domain-level audit events. */
@Module({
  imports: [IdentityModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
