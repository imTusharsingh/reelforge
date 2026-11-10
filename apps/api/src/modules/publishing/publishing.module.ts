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
import {
  PUBLISHING_BUDGET_PORT,
  PUBLISHING_SCHEDULE_PORT,
  UnconfiguredPublishingBudgetPort,
  UnconfiguredPublishingSchedulePort,
} from "./publishing.ports.js";
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
  controllers: [PublishingController],
  providers: [
    PublishingService,
    {
      // M19-T06: an active emergency stop fails the M13 preflight (publish/retry); reconcile is
      // unaffected. Otherwise the existing (still unconfigured, fail-closed) schedule port decides.
      provide: PUBLISHING_SCHEDULE_PORT,
      useFactory: (stop: EmergencyStopPort): EmergencyStopPublishingSchedulePort =>
        new EmergencyStopPublishingSchedulePort(stop, new UnconfiguredPublishingSchedulePort()),
      inject: [EMERGENCY_STOP_PORT],
    },
    {
      provide: PUBLISHING_BUDGET_PORT,
      useClass: UnconfiguredPublishingBudgetPort,
    },
    {
      provide: PublishingSessionVault,
      useFactory: (): PublishingSessionVault =>
        new PublishingSessionVault(process.env.PUBLISH_SESSION_ENCRYPTION_KEY),
    },
  ],
  exports: [PublishingService],
})
export class PublishingModule {}
