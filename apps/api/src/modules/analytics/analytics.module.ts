import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PublishingModule } from "../publishing/publishing.module.js";
import { SocialAccountsModule } from "../social-accounts/social-accounts.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PublishingPublishedPostSource } from "./analytics.publishing-source.js";
import { ANALYTICS_YOUTUBE_CLIENT, PUBLISHED_POST_SOURCE } from "./analytics.tokens.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { M12YouTubeAnalyticsClient } from "./analytics.youtube-client.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, SocialAccountsModule, PublishingModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    {
      provide: ANALYTICS_YOUTUBE_CLIENT,
      useClass: M12YouTubeAnalyticsClient,
    },
    {
      provide: PUBLISHED_POST_SOURCE,
      useClass: PublishingPublishedPostSource,
    },
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
