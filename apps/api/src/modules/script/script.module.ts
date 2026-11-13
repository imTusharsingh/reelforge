import { Module } from "@nestjs/common";
import { SCRIPT_LLM, type CapabilityMetadata } from "@reelforge/ai-providers";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";
import { ScriptController } from "./script.controller.js";
import { IdentityModule } from "../identity/identity.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PROVIDER_REGISTRY, ProviderRegistry } from "@reelforge/ai-providers";
import { OpenAiScriptLlm, openAiRuntimeConfig } from "../openai/openai.adapters.js";

class NotConfiguredScriptLlm implements ScriptLlmPort {
  public readonly capability: CapabilityMetadata = {
    providerId: "unconfigured",
    capabilityId: "llm",
    kind: "llm",
    input: ["text"],
    output: ["json"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: null },
  };
  public complete(): never {
    throw new Error("Script LLM is not configured");
  }
}
@Module({
  imports: [IdentityModule, WorkspaceModule, UsageBudgetModule],
  controllers: [ScriptController],
  providers: [
    ScriptService,
    {
      provide: SCRIPT_LLM,
      useFactory: (): ScriptLlmPort => {
        const config = openAiRuntimeConfig();
        return config.key === undefined
          ? new NotConfiguredScriptLlm()
          : new OpenAiScriptLlm(config.key, config.textModel);
      },
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (): ProviderRegistry => {
        const registry = new ProviderRegistry();
        const config = openAiRuntimeConfig();
        if (config.key !== undefined) {
          const adapter = new OpenAiScriptLlm(config.key, config.textModel);
          registry.register({
            capability: adapter.capability,
            credential: {
              providerId: adapter.capability.providerId,
              environment: process.env.NODE_ENV === "production" ? "production" : "development",
              secret: config.key,
            },
          });
        }
        return registry;
      },
    },
  ],
  exports: [ScriptService],
})
export class ScriptModule {}
