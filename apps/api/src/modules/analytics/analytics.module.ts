import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { SocialAccountsModule } from "../social-accounts/social-accounts.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import {
  ANALYTICS_YOUTUBE_CLIENT,
  NotConfiguredPublishedPostSource,
  NotConfiguredYouTubeAnalyticsClient,
  PUBLISHED_POST_SOURCE,
} from "./analytics.tokens.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, SocialAccountsModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    {
      provide: ANALYTICS_YOUTUBE_CLIENT,
      useFactory: (): NotConfiguredYouTubeAnalyticsClient =>
        new NotConfiguredYouTubeAnalyticsClient(),
    },
    {
      provide: PUBLISHED_POST_SOURCE,
      useFactory: (): NotConfiguredPublishedPostSource => new NotConfiguredPublishedPostSource(),
    },
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
