import { Module } from "@nestjs/common";
import { IdentityModule } from "../../identity/identity.module.js";
import { WorkspaceModule } from "../../workspace/workspace.module.js";
import { ProvidersModule } from "../../openai/providers.module.js";
import { UsageBudgetModule } from "../../usage-budget/usage-budget.module.js";
import { PublishingModule } from "../../publishing/publishing.module.js";
import { DiscoveryLearningSource } from "../../analytics/discovery-learning-source.js";
import { DiscoveryController } from "./controller.js";
import { DiscoveryService } from "./service.js";
import { DiscoveryStore } from "./store.js";
import { DiscoveryScout } from "./scout.js";
import { DiscoveryQuotaService } from "./quota.js";
import { DiscoveryTextCalls } from "./text-calls.js";
import { DiscoveryYouTube } from "./youtube.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, ProvidersModule, UsageBudgetModule, PublishingModule],
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    DiscoveryStore,
    DiscoveryScout,
    DiscoveryQuotaService,
    DiscoveryTextCalls,
    DiscoveryYouTube,
    DiscoveryLearningSource,
    { provide: "V10_DISCOVERY", useExisting: DiscoveryService },
  ],
  exports: ["V10_DISCOVERY"],
})
export class DiscoveryModule {}
