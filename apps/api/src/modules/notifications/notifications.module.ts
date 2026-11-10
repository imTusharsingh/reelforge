import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { ChannelModule } from "../channel/channel.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { OrchestrationModule } from "../orchestration/orchestration.module.js";
import { PerformanceIntelligenceModule } from "../performance-intelligence/performance-intelligence.module.js";
import { PublishingModule } from "../publishing/publishing.module.js";
import { QualityModule } from "../quality/quality.module.js";
import { SocialAccountsModule } from "../social-accounts/social-accounts.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { ChannelReportsController, NotificationsController } from "./notifications.controller.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  NOTIFICATIONS_CLOCK,
  NOTIFICATIONS_CONFIG,
  NOTIFICATION_EMAIL_PORT,
  NotConfiguredNotificationEmail,
} from "./notifications.ports.js";
import { NotificationsService } from "./notifications.service.js";
import { NotificationIntakeSources } from "./notifications.sources.js";
import { ChannelReportsService } from "./reports.service.js";

@Module({
  imports: [
    IdentityModule,
    WorkspaceModule,
    ChannelModule,
    QualityModule,
    PublishingModule,
    SocialAccountsModule,
    AnalyticsModule,
    PerformanceIntelligenceModule,
    OrchestrationModule,
  ],
  controllers: [NotificationsController, ChannelReportsController],
  providers: [
    NotificationIntakeSources,
    NotificationsService,
    ChannelReportsService,
    // M17-T03: no sender credential is configured, so email stays NOT_CONFIGURED.
    { provide: NOTIFICATION_EMAIL_PORT, useClass: NotConfiguredNotificationEmail },
    { provide: NOTIFICATIONS_CLOCK, useValue: (): Date => new Date() },
    { provide: NOTIFICATIONS_CONFIG, useValue: DEFAULT_NOTIFICATIONS_CONFIG },
  ],
  exports: [NotificationsService, ChannelReportsService],
})
export class NotificationsModule {}
