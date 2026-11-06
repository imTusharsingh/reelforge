export type IdeaProposal = Readonly<{
  title: string;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: string[];
  expectedFormat: string;
}>;

export type LlmCompletionMetadata = Readonly<{
  modelVersion: string;
  promptVersion: string;
  cost: number | null;
  currency?: string;
}>;

export type IdeaProposalResult = Readonly<{
  proposal: IdeaProposal;
  metadata: LlmCompletionMetadata;
}>;

export interface IdeaProposalLlmPort {
  proposeIdea(input: Readonly<{ prompt: string; context?: string }>): Promise<IdeaProposalResult>;
}

export const IDEA_PROPOSAL_LLM = Symbol("IDEA_PROPOSAL_LLM");
