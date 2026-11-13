import { Module } from "@nestjs/common";
import { IDEA_PROPOSAL_LLM, type IdeaProposalLlmPort } from "@reelforge/ai-providers";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { UsageBudgetModule } from "../usage-budget/usage-budget.module.js";
import { IdeaController } from "./idea.controller.js";
import { IdeaService } from "./idea.service.js";
import { OpenAiIdeaProposalLlm, openAiKey, openAiTextModel } from "../openai/openai.adapters.js";

class NotConfiguredIdeaLlm implements IdeaProposalLlmPort {
  public proposeIdea(): never {
    throw new Error("Idea proposal LLM is not configured");
  }
}

@Module({
  imports: [IdentityModule, WorkspaceModule, UsageBudgetModule],
  controllers: [IdeaController],
  providers: [
    IdeaService,
    {
      provide: IDEA_PROPOSAL_LLM,
      useFactory: (): IdeaProposalLlmPort => {
        const key = openAiKey();
        return key === undefined
          ? new NotConfiguredIdeaLlm()
          : new OpenAiIdeaProposalLlm(key, openAiTextModel());
      },
    },
  ],
  exports: [IdeaService],
})
export class IdeaModule {}
