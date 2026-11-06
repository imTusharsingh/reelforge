import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { SCRIPT_LLM, type ProviderProvenance } from "@reelforge/ai-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { ScriptLlmPort } from "./script.types.js";
import { parseScriptDocument, validateScript } from "./script.validation.js";

@Injectable()
export class ScriptService {
  public constructor(@Inject(SCRIPT_LLM) private readonly llm: ScriptLlmPort) {}
  public async generate(
    context: WorkspaceContext,
    input: Readonly<{
      approvedIdeaSnapshotId: string;
      approvedIdeaChecksum: string;
      prompt: string;
    }>,
  ): Promise<{ document: ReturnType<typeof parseScriptDocument>; provenance: ProviderProvenance }> {
    if (!context.workspaceId) throw new BadRequestException("Workspace is required");
    const result = await this.llm.complete({
      prompt: input.prompt,
      correlationId: `${context.workspaceId}:${input.approvedIdeaSnapshotId}`,
    });
    const document = parseScriptDocument(result.output);
    validateScript(document);
    return { document, provenance: result.metadata };
  }
}
