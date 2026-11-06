import { Module } from "@nestjs/common";
import { IDEA_PROPOSAL_LLM, type IdeaProposalLlmPort } from "@reelforge/ai-providers";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceModule } from "../workspace/workspace.module.js";
import { IdeaController } from "./idea.controller.js";
import { IdeaService } from "./idea.service.js";

class NotConfiguredIdeaLlm implements IdeaProposalLlmPort {
  public proposeIdea(): never {
    throw new Error("Idea proposal LLM is not configured");
  }
}

@Module({
  imports: [IdentityModule, WorkspaceModule],
  controllers: [IdeaController],
  providers: [IdeaService, { provide: IDEA_PROPOSAL_LLM, useClass: NotConfiguredIdeaLlm }],
  exports: [IdeaService],
})
export class IdeaModule {}
