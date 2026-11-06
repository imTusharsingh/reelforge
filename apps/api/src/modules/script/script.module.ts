import { Module } from "@nestjs/common";
import { SCRIPT_LLM, type CapabilityMetadata } from "@reelforge/ai-providers";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";
import { ScriptController } from "./script.controller.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PROVIDER_REGISTRY, ProviderRegistry } from "@reelforge/ai-providers";

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
  imports: [IdentityModule, WorkspaceModule],
  controllers: [ScriptController],
  providers: [
    ScriptService,
    { provide: SCRIPT_LLM, useClass: NotConfiguredScriptLlm },
    { provide: PROVIDER_REGISTRY, useClass: ProviderRegistry },
  ],
  exports: [ScriptService],
})
export class ScriptModule {}
