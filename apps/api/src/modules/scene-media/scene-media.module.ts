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
import { providerEnvironment } from "./scene-media.validation.js";
import {
  OpenAiImageProvider,
  OpenAiTtsProvider,
  OpenAiVideoProvider,
  openAiRuntimeConfig,
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
        const config = openAiRuntimeConfig();
        return config.key === undefined
          ? new NotConfiguredImageProvider()
          : new OpenAiImageProvider(config.key, config.imageModel);
      },
    },
    {
      provide: VIDEO_PROVIDER,
      useFactory: (): NotConfiguredVideoProvider | OpenAiVideoProvider => {
        const config = openAiRuntimeConfig();
        return config.key === undefined || config.videoModel === undefined
          ? new NotConfiguredVideoProvider()
          : new OpenAiVideoProvider(config.key, config.videoModel);
      },
    },
    {
      provide: TTS_PROVIDER,
      useFactory: (): NotConfiguredTtsProvider | OpenAiTtsProvider => {
        const config = openAiRuntimeConfig();
        return config.key === undefined
          ? new NotConfiguredTtsProvider()
          : new OpenAiTtsProvider(config.key, config.ttsModel);
      },
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (): ProviderRegistry => {
        const registry = new ProviderRegistry();
        const config = openAiRuntimeConfig();
        if (config.key === undefined) return registry;
        const adapters = [
          new OpenAiImageProvider(config.key, config.imageModel),
          new OpenAiTtsProvider(config.key, config.ttsModel),
          ...(config.videoModel === undefined
            ? []
            : [new OpenAiVideoProvider(config.key, config.videoModel)]),
        ];
        for (const adapter of adapters) {
          registry.register({
            capability: adapter.capability,
            credential: {
              providerId: adapter.capability.providerId,
              environment: providerEnvironment(),
              secret: config.key,
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
