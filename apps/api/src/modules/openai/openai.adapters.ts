import { z } from "zod";
import {
  ProviderError,
  type CapabilityMetadata,
  type IdeaProposalLlmPort,
  type IdeaProposalResult,
  type ImageProviderPort,
  type ImageRequest,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type MediaGenerationResponse,
  type ProviderProvenance,
  type QualityReviewPort,
  type QualityReviewRequest,
  type QualityReviewResult,
  type TtsProviderPort,
  type TtsRequest,
  type VideoProviderPort,
  type VideoRequest,
} from "@reelforge/ai-providers";
import type {
  InsightNarrativeInput,
  InsightNarrativeResult,
  InsightReportLlmPort,
} from "../performance-intelligence/performance-intelligence.ports.js";

type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;
type OpenAiHttpResult = Readonly<{ body: JsonRecord; requestId: string | null }>;

const OPENAI_API = "https://api.openai.com/v1";
const DEFAULT_TEXT_MODEL = "gpt-4.1-mini";
const DEFAULT_IMAGE_MODEL = "gpt-image-2.6-sunburst";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

export const OPENAI_TEXT_TIMEOUT_MS = 60_000;
export const OPENAI_IMAGE_TIMEOUT_MS = 120_000;
export const OPENAI_TTS_TIMEOUT_MS = 60_000;
export const OPENAI_VIDEO_SUBMIT_TIMEOUT_MS = 30_000;
export const OPENAI_VIDEO_POLL_INTERVAL_MS = 5_000;
export const OPENAI_VIDEO_POLL_TIMEOUT_MS = 30_000;
export const OPENAI_VIDEO_CONTENT_TIMEOUT_MS = 30_000;
export const OPENAI_VIDEO_OVERALL_TIMEOUT_MS = 15 * 60_000;
export const OPENAI_TEXT_ESTIMATE_USD = 2;
export const OPENAI_IMAGE_ESTIMATE_USD = 10;
export const OPENAI_TTS_ESTIMATE_USD = 1;
export const OPENAI_VIDEO_ESTIMATE_USD = 100;
/** Durations accepted by the documented OpenAI Videos API create body. */
export const OPENAI_VIDEO_SECONDS = [4, 8, 12] as const;
const VIDEO_SIZE = "720x1280";
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function mediaCapability(
  capabilityId: string,
  kind: "image" | "video" | "tts",
  amount: number,
  asynchronous = false,
): CapabilityMetadata {
  return {
    providerId: "openai",
    capabilityId,
    kind,
    input: kind === "tts" ? ["text"] : ["text"],
    output: [kind === "tts" ? "audio/mpeg" : kind === "image" ? "image/png" : "video/mp4"],
    supportsReferenceImages: false,
    asynchronous,
    polling: asynchronous,
    regions: ["global"],
    ...(kind === "video" ? { durationSeconds: { min: 4, max: 12 } } : {}),
    ...(kind === "image" ? { resolution: { maxWidth: 1536, maxHeight: 1536 } } : {}),
    ...(kind === "video" ? { resolution: { maxWidth: 1280, maxHeight: 1280 } } : {}),
    costModel: { currency: "USD", unit: "request", amount },
  };
}

function model(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function providerError(
  status: number,
  message: string,
  correlationId: string,
  providerJobId?: string,
): ProviderError {
  const code =
    status === 408 || status === 429 || status >= 500
      ? "PROVIDER_UNAVAILABLE"
      : "PROVIDER_REJECTED";
  return new ProviderError(code, message, correlationId, {
    providerCalled: true,
    ...(providerJobId === undefined ? {} : { providerJobId }),
  });
}

function notSent(
  code: ProviderError["code"],
  message: string,
  correlationId: string,
): ProviderError {
  return new ProviderError(code, message, correlationId, { providerCalled: false });
}

async function requestJson(
  fetcher: FetchImplementation,
  apiKey: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  correlationId: string,
  providerJobId?: string,
): Promise<OpenAiHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${OPENAI_API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw providerError(response.status, "OpenAI request failed", correlationId, providerJobId);
    }
    if (typeof body !== "object" || body === null) {
      throw new ProviderError("UNKNOWN", "OpenAI returned an invalid response", correlationId, {
        providerCalled: true,
        ...(providerJobId === undefined ? {} : { providerJobId }),
      });
    }
    return { body: body as JsonRecord, requestId: headerValue(response, "x-request-id") };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = isAbortError(error);
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      timedOut ? "OpenAI request timed out" : "OpenAI request failed",
      correlationId,
      {
        providerCalled: true,
        ...(providerJobId === undefined ? {} : { providerJobId }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestBytes(
  fetcher: FetchImplementation,
  apiKey: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  correlationId: string,
  providerJobId?: string,
): Promise<Readonly<{ body: Uint8Array; requestId: string | null }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${OPENAI_API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      throw providerError(response.status, "OpenAI request failed", correlationId, providerJobId);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength === 0) {
      throw new ProviderError("UNKNOWN", "OpenAI returned empty media", correlationId, {
        providerCalled: true,
        ...(providerJobId === undefined ? {} : { providerJobId }),
      });
    }
    return { body, requestId: headerValue(response, "x-request-id") };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = isAbortError(error);
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      timedOut ? "OpenAI request timed out" : "OpenAI request failed",
      correlationId,
      {
        providerCalled: true,
        ...(providerJobId === undefined ? {} : { providerJobId }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function headerValue(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function stringValue(value: unknown, label: string, correlationId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderError("UNKNOWN", `OpenAI response is missing ${label}`, correlationId, {
      providerCalled: true,
    });
  }
  return value;
}

function jsonOutput(body: JsonRecord, correlationId: string): unknown {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new ProviderError("UNKNOWN", "OpenAI response has no choices", correlationId, {
      providerCalled: true,
    });
  }
  const message = choices[0].message;
  if (!isRecord(message)) {
    throw new ProviderError("UNKNOWN", "OpenAI response has no message", correlationId, {
      providerCalled: true,
    });
  }
  const content = stringValue(message.content, "content", correlationId);
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ProviderError("UNKNOWN", "OpenAI returned invalid JSON", correlationId, {
      providerCalled: true,
    });
  }
}

function provenance(modelVersion: string, body: JsonRecord): ProviderProvenance {
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const inputTokens = numberField(usage, "prompt_tokens") ?? numberField(usage, "input_tokens");
  const outputTokens =
    numberField(usage, "completion_tokens") ?? numberField(usage, "output_tokens");
  return {
    modelVersion,
    promptVersion: "openai-chat-completions-v1",
    cost: null,
    ...(inputTokens === undefined && outputTokens === undefined
      ? {}
      : {
          usage: {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
          },
        }),
  };
}

function numberField(record: JsonRecord | undefined, key: string): number | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(encoded: string, correlationId: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ProviderError("UNKNOWN", "OpenAI image response is not base64", correlationId, {
      providerCalled: true,
    });
  }
  const body = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (body.byteLength === 0) {
    throw new ProviderError("UNKNOWN", "OpenAI image response has no bytes", correlationId, {
      providerCalled: true,
    });
  }
  return body;
}

function assertJobId(jobId: string, correlationId: string, providerCalled: boolean): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new ProviderError("UNKNOWN", "OpenAI video job id is invalid", correlationId, {
      providerCalled,
    });
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

class OpenAiTextClient {
  public constructor(
    protected readonly apiKey: string,
    protected readonly modelId: string,
    public readonly capability: CapabilityMetadata,
    protected readonly fetcher: FetchImplementation = fetch,
  ) {}

  protected async completeJson(request: LlmRequest, systemPrompt: string): Promise<LlmResponse> {
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

export class OpenAiImageProvider implements ImageProviderPort {
  public readonly capability: CapabilityMetadata;

  public constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetcher: FetchImplementation = fetch,
  ) {
    this.capability = mediaCapability("image-generation", "image", OPENAI_IMAGE_ESTIMATE_USD);
  }

  public async generate(request: ImageRequest): Promise<MediaGenerationResponse> {
    if (request.prompt.trim().length === 0) {
      throw notSent("INVALID_REQUEST", "Image prompt is empty", request.correlationId);
    }
    const result = await requestJson(
      this.fetcher,
      this.apiKey,
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelId,
          prompt: request.prompt,
          n: 1,
          size: "1024x1536",
          output_format: "png",
        }),
      },
      OPENAI_IMAGE_TIMEOUT_MS,
      request.correlationId,
    );
    const first = Array.isArray(result.body.data) ? result.body.data[0] : undefined;
    if (!isRecord(first) || typeof first.b64_json !== "string") {
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI image response is invalid",
        request.correlationId,
        {
          providerCalled: true,
        },
      );
    }
    const providerRequestId =
      result.requestId ?? (typeof result.body.id === "string" ? result.body.id : null);
    if (providerRequestId === null) {
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI image response has no request id",
        request.correlationId,
        {
          providerCalled: true,
        },
      );
    }
    return {
      mediaId: providerRequestId,
      providerRequestId,
      metadata: { modelVersion: this.modelId, promptVersion: "openai-images-v1", cost: null },
      media: {
        declaredMediaType: "image/png",
        body: decodeBase64(first.b64_json, request.correlationId),
      },
    };
  }
}

export class OpenAiTtsProvider implements TtsProviderPort {
  public readonly capability: CapabilityMetadata;

  public constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetcher: FetchImplementation = fetch,
  ) {
    this.capability = mediaCapability("tts", "tts", OPENAI_TTS_ESTIMATE_USD);
  }

  public async synthesize(request: TtsRequest): Promise<MediaGenerationResponse> {
    if (request.text.trim().length === 0 || request.voice.trim().length === 0) {
      throw notSent("INVALID_REQUEST", "Speech text or voice is empty", request.correlationId);
    }
    const result = await requestBytes(
      this.fetcher,
      this.apiKey,
      "/audio/speech",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelId,
          input: request.text,
          voice: request.voice,
          response_format: "mp3",
        }),
      },
      OPENAI_TTS_TIMEOUT_MS,
      request.correlationId,
    );
    if (result.requestId === null) {
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI speech response has no request id",
        request.correlationId,
        {
          providerCalled: true,
        },
      );
    }
    return {
      mediaId: result.requestId,
      providerRequestId: result.requestId,
      metadata: { modelVersion: this.modelId, promptVersion: "openai-tts-v1", cost: null },
      media: { declaredMediaType: "audio/mpeg", body: result.body },
    };
  }
}

export class OpenAiVideoProvider implements VideoProviderPort {
  public readonly capability: CapabilityMetadata;

  public constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetcher: FetchImplementation = fetch,
  ) {
    this.capability = mediaCapability("video", "video", OPENAI_VIDEO_ESTIMATE_USD, true);
  }

  public async generate(request: VideoRequest): Promise<MediaGenerationResponse> {
    const allowed = (OPENAI_VIDEO_SECONDS as readonly number[]).includes(request.durationSeconds);
    if (request.providerJobId === undefined && !allowed) {
      throw notSent(
        "INVALID_REQUEST",
        "OpenAI video accepts only 4, 8, or 12 second clips",
        request.correlationId,
      );
    }
    if (request.providerJobId === undefined && request.prompt.trim().length === 0) {
      throw notSent("INVALID_REQUEST", "Video prompt is empty", request.correlationId);
    }
    const submitted =
      request.providerJobId === undefined
        ? (
            await requestJson(
              this.fetcher,
              this.apiKey,
              "/videos",
              {
                method: "POST",
                headers: {
                  "Idempotency-Key": request.idempotencyKey ?? request.correlationId,
                },
                body: JSON.stringify({
                  model: this.modelId,
                  prompt: request.prompt,
                  seconds: String(request.durationSeconds),
                  size: VIDEO_SIZE,
                }),
              },
              OPENAI_VIDEO_SUBMIT_TIMEOUT_MS,
              request.correlationId,
            )
          ).body
        : { id: request.providerJobId, status: "queued" };
    const jobId = stringValue(submitted.id, "video job id", request.correlationId);
    assertJobId(jobId, request.correlationId, request.providerJobId === undefined);
    if (request.onProviderJobAccepted !== undefined) {
      try {
        await request.onProviderJobAccepted(jobId);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "OpenAI video job id could not be stored",
          request.correlationId,
          { providerCalled: true, providerJobId: jobId },
        );
      }
    }
    const deadline = Date.now() + OPENAI_VIDEO_OVERALL_TIMEOUT_MS;
    let job: JsonRecord = submitted;
    while (true) {
      const status = typeof job.status === "string" ? job.status : "queued";
      if (status === "completed") break;
      if (status === "failed" || status === "canceled" || status === "cancelled") {
        throw new ProviderError(
          "PROVIDER_REJECTED",
          "OpenAI video job failed",
          request.correlationId,
          {
            providerCalled: true,
            providerJobId: jobId,
          },
        );
      }
      if (Date.now() + OPENAI_VIDEO_POLL_INTERVAL_MS > deadline) {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "OpenAI video job timed out",
          request.correlationId,
          { providerCalled: true, providerJobId: jobId },
        );
      }
      await sleep(OPENAI_VIDEO_POLL_INTERVAL_MS);
      if (Date.now() >= deadline) {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "OpenAI video job timed out",
          request.correlationId,
          { providerCalled: true, providerJobId: jobId },
        );
      }
      const polled = await requestJson(
        this.fetcher,
        this.apiKey,
        `/videos/${jobId}`,
        { method: "GET" },
        OPENAI_VIDEO_POLL_TIMEOUT_MS,
        request.correlationId,
        jobId,
      );
      job = polled.body;
    }
    const content = await requestBytes(
      this.fetcher,
      this.apiKey,
      `/videos/${jobId}/content`,
      { method: "GET" },
      OPENAI_VIDEO_CONTENT_TIMEOUT_MS,
      request.correlationId,
      jobId,
    );
    return {
      mediaId: jobId,
      providerJobId: jobId,
      providerRequestId: jobId,
      metadata: { modelVersion: this.modelId, promptVersion: "openai-video-v1", cost: null },
      media: { declaredMediaType: "video/mp4", body: content.body },
    };
  }
}

export type OpenAiRuntimeConfig = Readonly<{
  key: string | undefined;
  textModel: string;
  imageModel: string;
  ttsModel: string;
  videoModel: string | undefined;
}>;

/**
 * Reads the process environment. Test runs ignore a key so startup, unit tests, and CI cannot
 * bind a live adapter. Video stays unbound unless OPENAI_VIDEO_MODEL is explicitly set.
 */
export function openAiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OpenAiRuntimeConfig {
  return {
    key: openAiKey(env),
    textModel: openAiTextModel(env),
    imageModel: openAiImageModel(env),
    ttsModel: openAiTtsModel(env),
    videoModel: openAiVideoModel(env),
  };
}

export function openAiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV === "test") return undefined;
  const key = env.OPENAI_API_KEY?.trim();
  return key === undefined || key.length === 0 ? undefined : key;
}

export function openAiTextModel(env: NodeJS.ProcessEnv = process.env): string {
  return model(env, "OPENAI_TEXT_MODEL", DEFAULT_TEXT_MODEL);
}

export function openAiImageModel(env: NodeJS.ProcessEnv = process.env): string {
  return model(env, "OPENAI_IMAGE_MODEL", DEFAULT_IMAGE_MODEL);
}

export function openAiTtsModel(env: NodeJS.ProcessEnv = process.env): string {
  return model(env, "OPENAI_TTS_MODEL", DEFAULT_TTS_MODEL);
}

export function openAiVideoModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.NODE_ENV === "test") return undefined;
  const value = env.OPENAI_VIDEO_MODEL?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
