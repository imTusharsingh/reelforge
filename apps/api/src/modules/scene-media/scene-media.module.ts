import { Module } from "@nestjs/common";
import {
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
} from "@reelforge/ai-providers";
import { AssetModule } from "../asset/asset.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PrismaSceneDispatchLedger, SCENE_DISPATCH_LEDGER } from "./scene-media.budget.js";
import {
  NotConfiguredImageProvider,
  NotConfiguredTtsProvider,
  NotConfiguredVideoProvider,
  SceneMediaController,
} from "./scene-media.controller.js";
import { SceneMediaService } from "./scene-media.service.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule, UsageBudgetModule],
  controllers: [SceneMediaController],
  providers: [
    SceneMediaService,
    PrismaSceneDispatchLedger,
    { provide: SCENE_DISPATCH_LEDGER, useExisting: PrismaSceneDispatchLedger },
    { provide: IMAGE_PROVIDER, useClass: NotConfiguredImageProvider },
    { provide: VIDEO_PROVIDER, useClass: NotConfiguredVideoProvider },
    { provide: TTS_PROVIDER, useClass: NotConfiguredTtsProvider },
    { provide: PROVIDER_REGISTRY, useClass: ProviderRegistry },
  ],
  exports: [SceneMediaService],
})
export class SceneMediaModule {}
