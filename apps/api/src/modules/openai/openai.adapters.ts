import {
  ProviderError,
  providerKey,
  providerKeyIssue,
  type CapabilityMetadata,
  type LlmRequest,
  type LlmResponse,
} from "@reelforge/ai-providers";
import type {
  InsightNarrativeInput,
  InsightNarrativeResult,
  InsightReportLlmPort,
} from "../performance-intelligence/performance-intelligence.ports.js";

import { requestJson, notSent, jsonOutput, provenance, isRecord } from "./openai.http.js";
import { geminiLegacyText } from "./gemini.legacy.js";
type FetchImplementation = typeof fetch;

const OPENAI_TEXT_TIMEOUT_MS = 60_000;
const OPENAI_TEXT_ESTIMATE_USD = 2;

function textCapability(capabilityId: string, amount: number): CapabilityMetadata {
  return {
    providerId: "openai",
    capabilityId,
    kind: "llm",
    input: ["text"],
    output: ["json"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: ["global"],
    costModel: { currency: "USD", unit: "request", amount },
  };
}

class OpenAiTextClient {
  public constructor(
    protected readonly apiKey: string,
    protected readonly modelId: string,
    public readonly capability: CapabilityMetadata,
    protected readonly fetcher: FetchImplementation = fetch,
  ) {
    if (apiKey === process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "test")
      this.capability = { ...capability, providerId: "gemini" };
  }

  protected async completeJson(request: LlmRequest, systemPrompt: string): Promise<LlmResponse> {
    if (!this.modelId.trim())
      throw notSent("NOT_CONFIGURED", "Text model and key are required", request.correlationId);
    if (this.apiKey === process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "test")
      return geminiLegacyText(this.apiKey, this.modelId, this.fetcher, request, systemPrompt);
    const result = await requestJson(
      this.fetcher,
      this.apiKey,
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: request.prompt },
          ],
          response_format: { type: "json_object" },
        }),
      },
      OPENAI_TEXT_TIMEOUT_MS,
      request.correlationId,
    );
    return {
      output: jsonOutput(result.body, request.correlationId),
      metadata: provenance(this.modelId, result.body),
      ...(typeof result.body.id === "string" ? { providerRequestId: result.body.id } : {}),
    };
  }
}

const INSIGHT_SYSTEM_PROMPT =
  "Return JSON with a narrative string grounded only in the supplied performance evidence. Do not invent metrics.";

export class OpenAiInsightReportLlm extends OpenAiTextClient implements InsightReportLlmPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("insight-report", OPENAI_TEXT_ESTIMATE_USD), fetcher);
  }

  public isConfigured(): boolean {
    return !providerKeyIssue(
      this.capability.providerId === "gemini" ? "gemini" : "openai",
      this.apiKey,
    );
  }

  public async generate(input: InsightNarrativeInput): Promise<InsightNarrativeResult> {
    const correlationId = input.correlationId ?? "insight-adapter";
    const result = await this.completeJson(
      { prompt: JSON.stringify(input), correlationId },
      INSIGHT_SYSTEM_PROMPT,
    );
    const output = result.output;
    if (
      !isRecord(output) ||
      typeof output.narrative !== "string" ||
      output.narrative.trim() === ""
    ) {
      throw new ProviderError("UNKNOWN", "OpenAI insight response is invalid", correlationId, {
        providerCalled: true,
      });
    }
    return { narrative: output.narrative, provenance: result.metadata };
  }
}

export type OpenAiRuntimeConfig = Readonly<{
  key: string | undefined;
  textModel: string;
  textFallbackEnabled: boolean;
  imageModel: string;
  ttsModel: string;
}>;
export function openAiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OpenAiRuntimeConfig {
  const gemini = providerKey("gemini", env);
  return {
    key: gemini ?? (env.OPENAI_TEXT_FALLBACK_ENABLED === "true" ? openAiKey(env) : undefined),
    textModel: gemini ? env.GEMINI_TEXT_MODEL?.trim() || "" : openAiTextModel(env),
    textFallbackEnabled:
      !!gemini || (env.NODE_ENV !== "test" && env.OPENAI_TEXT_FALLBACK_ENABLED === "true"),
    imageModel: env.GEMINI_IMAGE_MODEL?.trim() || "",
    ttsModel: env.GEMINI_TTS_MODEL?.trim() || "",
  };
}
export function openAiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.NODE_ENV === "test" ? undefined : env.OPENAI_API_KEY || undefined;
}
export function openAiTextModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENAI_TEXT_MODEL?.trim() || "";
}
