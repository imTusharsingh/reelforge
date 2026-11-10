import { Module } from "@nestjs/common";
import { EmergencyStopModule } from "../admin/emergency-stop.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { NotConfiguredBillingProvider } from "./usage-budget.billing.js";
import { UsageBudgetController } from "./usage-budget.controller.js";
import { UsageBudgetPolicy } from "./usage-budget.policy.js";
import { UsageBudgetService } from "./usage-budget.service.js";
import { BILLING_PROVIDER, USAGE_CLOCK } from "./usage-budget.types.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, EmergencyStopModule],
  controllers: [UsageBudgetController],
  providers: [
    UsageBudgetService,
    UsageBudgetPolicy,
    { provide: USAGE_CLOCK, useValue: (): Date => new Date() },
    { provide: BILLING_PROVIDER, useClass: NotConfiguredBillingProvider },
  ],
  exports: [UsageBudgetService, UsageBudgetPolicy],
})
export class UsageBudgetModule {}
