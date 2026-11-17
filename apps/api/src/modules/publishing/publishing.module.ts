import { AutomationPolicy } from "./automation-policy.js";
import { AutomationSlots } from "./automation-slots.js";
import { PublishingAutomation } from "./automation.service.js";
import { AutomationController } from "./automation.controller.js";
import { RunsStore } from "../runs/runs.store.js";
import { Module } from "@nestjs/common";
import { EmergencyStopPublishingSchedulePort } from "../admin/emergency-stop.adapters.js";
import { EmergencyStopModule } from "../admin/emergency-stop.module.js";
import { EMERGENCY_STOP_PORT, type EmergencyStopPort } from "../admin/emergency-stop.types.js";
import { AssetModule } from "../asset/asset.module.js";
import { CompositionModule } from "../composition/composition.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { QualityModule } from "../quality/quality.module.js";
import { SocialAccountsModule } from "../social-accounts/social-accounts.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PUBLISHING_BUDGET_PORT, PUBLISHING_SCHEDULE_PORT } from "./publishing.ports.js";
import { PublishingController } from "./publishing.controller.js";
import { PublishingService } from "./publishing.service.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";

@Module({
  imports: [
    AssetModule,
    CompositionModule,
    IdentityModule,
    QualityModule,
    SocialAccountsModule,
    WorkspaceModule,
    EmergencyStopModule,
  ],
  controllers: [PublishingController, AutomationController],
  providers: [
    PublishingService,
    RunsStore,
    AutomationSlots,
    PublishingAutomation,
    AutomationPolicy,
    { provide: "V9_PUBLISHING", useExisting: PublishingAutomation },
    {
      // M19-T06: an active emergency stop fails the M13 preflight (publish/retry); reconcile is
      // unaffected. V9 policy permits only a slot bound to current V8 approval and budget evidence.
      provide: PUBLISHING_SCHEDULE_PORT,
      useFactory: (
        stop: EmergencyStopPort,
        policy: AutomationPolicy,
      ): EmergencyStopPublishingSchedulePort =>
        new EmergencyStopPublishingSchedulePort(stop, policy),
      inject: [EMERGENCY_STOP_PORT, AutomationPolicy],
    },
    {
      provide: PUBLISHING_BUDGET_PORT,
      useExisting: AutomationPolicy,
    },
    {
      provide: PublishingSessionVault,
      useFactory: (): PublishingSessionVault =>
        new PublishingSessionVault(process.env.PUBLISH_SESSION_ENCRYPTION_KEY),
    },
  ],
  exports: [PublishingService, "V9_PUBLISHING"],
})
export class PublishingModule {}
