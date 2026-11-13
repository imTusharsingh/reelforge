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
import {
  OpenAiImageProvider,
  OpenAiTtsProvider,
  OpenAiVideoProvider,
  openAiImageModel,
  openAiKey,
  openAiTtsModel,
  openAiVideoModel,
} from "../openai/openai.adapters.js";

@Module({
  imports: [IdentityModule, WorkspaceModule, AssetModule, UsageBudgetModule],
  controllers: [SceneMediaController],
  providers: [
    SceneMediaService,
    PrismaSceneDispatchLedger,
    { provide: SCENE_DISPATCH_LEDGER, useExisting: PrismaSceneDispatchLedger },
    {
      provide: IMAGE_PROVIDER,
      useFactory: (): NotConfiguredImageProvider | OpenAiImageProvider => {
        const key = openAiKey();
        return key === undefined
          ? new NotConfiguredImageProvider()
          : new OpenAiImageProvider(key, openAiImageModel());
      },
    },
    {
      provide: VIDEO_PROVIDER,
      useFactory: (): NotConfiguredVideoProvider | OpenAiVideoProvider => {
        const key = openAiKey();
        return key === undefined
          ? new NotConfiguredVideoProvider()
          : new OpenAiVideoProvider(key, openAiVideoModel());
      },
    },
    {
      provide: TTS_PROVIDER,
      useFactory: (): NotConfiguredTtsProvider | OpenAiTtsProvider => {
        const key = openAiKey();
        return key === undefined
          ? new NotConfiguredTtsProvider()
          : new OpenAiTtsProvider(key, openAiTtsModel());
      },
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (): ProviderRegistry => {
        const registry = new ProviderRegistry();
        const key = openAiKey();
        if (key !== undefined) {
          const adapters = [
            new OpenAiImageProvider(key, openAiImageModel()),
            new OpenAiVideoProvider(key, openAiVideoModel()),
            new OpenAiTtsProvider(key, openAiTtsModel()),
          ];
          for (const adapter of adapters)
            registry.register({
              capability: adapter.capability,
              credential: {
                providerId: adapter.capability.providerId,
                environment: process.env.NODE_ENV === "production" ? "production" : "development",
                secret: key,
              },
            });
        }
        return registry;
      },
    },
  ],
  exports: [SceneMediaService],
})
export class SceneMediaModule {}
