import { Module } from "@nestjs/common";
import { SCRIPT_LLM } from "@reelforge/ai-providers";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";

class NotConfiguredScriptLlm implements ScriptLlmPort {
  public readonly capability = undefined as never;
  public complete(): never {
    throw new Error("Script LLM is not configured");
  }
}
@Module({
  providers: [ScriptService, { provide: SCRIPT_LLM, useClass: NotConfiguredScriptLlm }],
  exports: [ScriptService],
})
export class ScriptModule {}
