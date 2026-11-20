import { ProvidersModule } from "./modules/openai/providers.module.js";
import { Module, RequestMethod } from "@nestjs/common";
import type { MiddlewareConsumer } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import { ChannelModule } from "./modules/channel/channel.module.js";
import { AssetModule } from "./modules/asset/asset.module.js";
import { CharacterModule } from "./modules/character/character.module.js";
import { SocialAccountsModule } from "./modules/social-accounts/social-accounts.module.js";
import { PublishingModule } from "./modules/publishing/publishing.module.js";
import { AnalyticsModule } from "./modules/analytics/analytics.module.js";
import { PerformanceIntelligenceModule } from "./modules/performance-intelligence/performance-intelligence.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { UsageBudgetModule } from "./modules/usage-budget/usage-budget.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { csrfMiddleware } from "./modules/identity/csrf.middleware.js";

@Module({
  imports: [
    ProvidersModule,
    IdentityModule,
    WorkspaceModule,
    ChannelModule,
    AssetModule,
    CharacterModule,
    SocialAccountsModule,
    PublishingModule,
    AnalyticsModule,
    PerformanceIntelligenceModule,
    NotificationsModule,
    UsageBudgetModule,
    AdminModule,
    DiscoveryModule,
    AutonomyModule,
    RunsModule,
    MediaPipelineModule,
    CriticModule,
  ],
  controllers: [HealthController],
})
// CSRF is deliberately middleware so it protects every cookie-authenticated unsafe route.
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(csrfMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}

import { DiscoveryModule } from "./modules/idea/discovery/module.js";
import { RunsModule } from "./modules/runs/runs.module.js";

import { AutonomyModule } from "./modules/autonomy/autonomy.module.js";
import { MediaPipelineModule } from "./modules/scene-media/media-pipeline.module.js";
import { CriticModule } from "./modules/quality/critic.module.js";
