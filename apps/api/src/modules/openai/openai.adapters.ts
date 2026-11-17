import { z } from "zod";
import {
  ProviderError,
  type CapabilityMetadata,
  type IdeaProposalLlmPort,
  type IdeaProposalResult,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type QualityReviewPort,
  type QualityReviewRequest,
  type QualityReviewResult,
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

const ideaProposalSchema = z
  .object({
    title: z.string().trim().min(1),
    topic: z.string().trim().min(1),
    hook: z.string().trim().min(1),
    angle: z.string().trim().min(1),
    audience: z.string().trim().min(1),
    references: z.array(z.string().trim().min(1)).optional(),
    expectedFormat: z.string().trim().min(1),
  })
  .strict();

const qualityCriterionSchema = z
  .object({
    score: z.number().finite().int().min(0).max(100),
    evidence: z.array(z.string().trim().min(1)).min(1),
    limitations: z.array(z.string().trim().min(1)),
  })
  .strict();

const qualityCriteriaSchema = z
  .object({
    criteria: z
      .object({
        FACTUALITY: qualityCriterionSchema,
        CLARITY: qualityCriterionSchema,
        COHERENCE: qualityCriterionSchema,
        ENGAGEMENT: qualityCriterionSchema,
        GENRE_FIT: qualityCriterionSchema,
      })
      .strict(),
  })
  .strict();

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
    if (!this.modelId.trim() || !this.apiKey.trim())
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

const IDEA_SYSTEM_PROMPT =
  "Return JSON with string fields title, topic, hook, angle, audience, and expectedFormat, and an optional references array of strings. Do not add other fields.";
const SCRIPT_SYSTEM_PROMPT =
  'Return JSON for a ReelForge script document with schemaVersion "1.0", title, hook, dialogue, cta, metadata (genre, targetDurationSeconds, factual), and a non-empty scenes array. Each scene needs id, startSeconds, durationSeconds, characterRefs, dialogue, visualDescription, camera, and audioCues.';
const QUALITY_SYSTEM_PROMPT =
  "Return JSON with a criteria object. FACTUALITY, CLARITY, COHERENCE, ENGAGEMENT, and GENRE_FIT each need an integer score from 0 to 100, a non-empty evidence array of strings, and a limitations array of strings.";
const INSIGHT_SYSTEM_PROMPT =
  "Return JSON with a narrative string grounded only in the supplied performance evidence. Do not invent metrics.";

export class OpenAiIdeaProposalLlm extends OpenAiTextClient implements IdeaProposalLlmPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("idea-proposal", OPENAI_TEXT_ESTIMATE_USD), fetcher);
  }

  public async proposeIdea(
    input: Readonly<{ prompt: string; context?: string; correlationId: string }>,
  ): Promise<IdeaProposalResult> {
    const result = await this.completeJson(
      {
        prompt: input.context === undefined ? input.prompt : `${input.prompt}\n${input.context}`,
        correlationId: input.correlationId,
      },
      IDEA_SYSTEM_PROMPT,
    );
    const parsed = ideaProposalSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new ProviderError("UNKNOWN", "OpenAI idea response is invalid", input.correlationId, {
        providerCalled: true,
      });
    }
    return {
      proposal: {
        ...parsed.data,
        references: parsed.data.references ?? [],
      },
      metadata: {
        modelVersion: result.metadata.modelVersion,
        promptVersion: result.metadata.promptVersion,
        cost: result.metadata.cost,
        ...(result.metadata.currency === undefined ? {} : { currency: result.metadata.currency }),
      },
    };
  }
}

export class OpenAiScriptLlm extends OpenAiTextClient implements LlmProviderPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("script", OPENAI_TEXT_ESTIMATE_USD), fetcher);
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.model !== undefined && request.model !== this.modelId) {
      throw notSent(
        "INVALID_REQUEST",
        "OpenAI text model cannot be overridden per request",
        request.correlationId,
      );
    }
    const result = await this.completeJson(
      { prompt: request.prompt, correlationId: request.correlationId },
      request.systemPrompt ?? SCRIPT_SYSTEM_PROMPT,
    );
    if (!isRecord(result.output)) {
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI script response is invalid",
        request.correlationId,
        {
          providerCalled: true,
        },
      );
    }
    return result;
  }
}

export class OpenAiQualityReviewPort extends OpenAiTextClient implements QualityReviewPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("quality-review", OPENAI_TEXT_ESTIMATE_USD), fetcher);
  }

  public async review(request: QualityReviewRequest): Promise<QualityReviewResult> {
    const result = await this.completeJson(
      { prompt: JSON.stringify(request), correlationId: request.correlationId },
      QUALITY_SYSTEM_PROMPT,
    );
    const parsed = qualityCriteriaSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI quality review response is invalid",
        request.correlationId,
        { providerCalled: true },
      );
    }
    return { criteria: parsed.data.criteria, metadata: result.metadata };
  }
}

export class OpenAiInsightReportLlm extends OpenAiTextClient implements InsightReportLlmPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("insight-report", OPENAI_TEXT_ESTIMATE_USD), fetcher);
  }

  public isConfigured(): boolean {
    return true;
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
  const gemini = env.NODE_ENV === "test" ? undefined : env.GEMINI_API_KEY?.trim() || undefined;
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
  return env.NODE_ENV === "test" ? undefined : env.OPENAI_API_KEY?.trim() || undefined;
}
export function openAiTextModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENAI_TEXT_MODEL?.trim() || "";
}
