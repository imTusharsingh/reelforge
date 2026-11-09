import { Module } from "@nestjs/common";
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
  ],
  controllers: [PublishingController],
  providers: [
    PublishingService,
    {
      provide: PUBLISHING_SCHEDULE_PORT,
      useClass: UnconfiguredPublishingSchedulePort,
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
