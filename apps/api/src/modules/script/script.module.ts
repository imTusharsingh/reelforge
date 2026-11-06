import { Module } from "@nestjs/common";
import { SCRIPT_LLM } from "@reelforge/ai-providers";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";
import { ScriptController } from "./script.controller.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { PROVIDER_REGISTRY, ProviderRegistry } from "@reelforge/ai-providers";

class NotConfiguredScriptLlm implements ScriptLlmPort {
  public readonly capability = undefined as never;
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
