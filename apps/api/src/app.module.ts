import { Module, RequestMethod } from "@nestjs/common";
import type { MiddlewareConsumer } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { WorkspaceModule } from "./modules/workspace/workspace.module.js";
import { ChannelModule } from "./modules/channel/channel.module.js";
import { GenreModule } from "./modules/genre/genre.module.js";
import { AssetModule } from "./modules/asset/asset.module.js";
import { CharacterModule } from "./modules/character/character.module.js";
import { ConfigModule } from "./modules/config/config.module.js";
import { IdeaModule } from "./modules/idea/idea.module.js";
import { ScriptModule } from "./modules/script/script.module.js";
import { SceneMediaModule } from "./modules/scene-media/scene-media.module.js";
import { CompositionModule } from "./modules/composition/composition.module.js";
import { QualityModule } from "./modules/quality/quality.module.js";
import { SocialAccountsModule } from "./modules/social-accounts/social-accounts.module.js";
import { PublishingModule } from "./modules/publishing/publishing.module.js";
import { AnalyticsModule } from "./modules/analytics/analytics.module.js";
import { PerformanceIntelligenceModule } from "./modules/performance-intelligence/performance-intelligence.module.js";
import { OrchestrationModule } from "./modules/orchestration/orchestration.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { UsageBudgetModule } from "./modules/usage-budget/usage-budget.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { csrfMiddleware } from "./modules/identity/csrf.middleware.js";

@Module({
  imports: [
    IdentityModule,
    WorkspaceModule,
    ChannelModule,
    GenreModule,
    AssetModule,
    CharacterModule,
    ConfigModule,
    IdeaModule,
    ScriptModule,
    SceneMediaModule,
    CompositionModule,
    QualityModule,
    SocialAccountsModule,
    PublishingModule,
    AnalyticsModule,
    PerformanceIntelligenceModule,
    OrchestrationModule,
    NotificationsModule,
    UsageBudgetModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
// CSRF is deliberately middleware so it protects every cookie-authenticated unsafe route.
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(csrfMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
