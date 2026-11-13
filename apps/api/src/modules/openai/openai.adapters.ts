import {
  ProviderError,
  type CapabilityMetadata,
  type ImageProviderPort,
  type ImageRequest,
  type LlmCompletionMetadata,
  type LlmProviderPort,
  type LlmRequest,
  type LlmResponse,
  type QualityReviewPort,
  type QualityReviewRequest,
  type QualityReviewResult,
  type TtsProviderPort,
  type TtsRequest,
  type VideoProviderPort,
  type VideoRequest,
  type MediaGenerationResponse,
  type ProviderProvenance,
} from "@reelforge/ai-providers";
import type { IdeaProposalLlmPort, IdeaProposalResult } from "@reelforge/ai-providers";
import type {
  InsightNarrativeInput,
  InsightNarrativeResult,
  InsightReportLlmPort,
} from "../performance-intelligence/performance-intelligence.ports.js";

type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;

const OPENAI_API = "https://api.openai.com/v1";
const DEFAULT_TEXT_MODEL = "gpt-4.1-mini";
const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VIDEO_MODEL = "sora-2";

function textCapability(capabilityId: string, model: string, amount: number): CapabilityMetadata {
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
  model: string,
  amount: number,
  asynchronous = false,
): CapabilityMetadata {
  return {
    providerId: "openai",
    capabilityId,
    kind,
    input: kind === "tts" ? ["text"] : ["text", "image"],
    output: [kind === "tts" ? "audio/mpeg" : kind === "image" ? "image/png" : "video/mp4"],
    supportsReferenceImages: false,
    asynchronous,
    polling: asynchronous,
    regions: ["global"],
    ...(kind === "video" ? { durationSeconds: { min: 1, max: 15 } } : {}),
    ...(kind === "image" || kind === "video"
      ? { resolution: { maxWidth: 4096, maxHeight: 4096 } }
      : {}),
    costModel: { currency: "USD", unit: "request", amount },
  };
}

function model(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

function providerError(status: number, message: string, correlationId: string): ProviderError {
  const code =
    status === 408 || status === 429 || status >= 500
      ? "PROVIDER_UNAVAILABLE"
      : "PROVIDER_REJECTED";
  return new ProviderError(code, message, correlationId);
}

async function requestJson(
  fetcher: FetchImplementation,
  apiKey: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  correlationId: string,
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${OPENAI_API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status, "OpenAI request failed", correlationId);
    if (typeof body !== "object" || body === null)
      throw new ProviderError("UNKNOWN", "OpenAI returned an invalid response", correlationId);
    return body as JsonRecord;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ProviderError("PROVIDER_UNAVAILABLE", "OpenAI request timed out", correlationId);
    throw new ProviderError("PROVIDER_UNAVAILABLE", "OpenAI request failed", correlationId);
  } finally {
    clearTimeout(timer);
  }
}

function stringValue(value: unknown, label: string, correlationId: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ProviderError("UNKNOWN", `OpenAI response is missing ${label}`, correlationId);
  return value;
}

function jsonOutput(body: JsonRecord, correlationId: string): unknown {
  const choices = body.choices;
  if (
    !Array.isArray(choices) ||
    choices.length === 0 ||
    typeof choices[0] !== "object" ||
    choices[0] === null
  )
    throw new ProviderError("UNKNOWN", "OpenAI response has no choices", correlationId);
  const message = (choices[0] as JsonRecord).message;
  if (typeof message !== "object" || message === null)
    throw new ProviderError("UNKNOWN", "OpenAI response has no message", correlationId);
  const content = stringValue((message as JsonRecord).content, "content", correlationId);
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ProviderError("UNKNOWN", "OpenAI returned invalid JSON", correlationId);
  }
}

function provenance(modelVersion: string, body: JsonRecord): ProviderProvenance {
  const usage =
    typeof body.usage === "object" && body.usage !== null ? (body.usage as JsonRecord) : undefined;
  return {
    modelVersion,
    promptVersion: "openai-chat-completions-v1",
    cost: null,
    ...(usage === undefined
      ? {}
      : {
          usage: {
            ...(typeof usage.prompt_tokens === "number"
              ? { inputTokens: usage.prompt_tokens }
              : {}),
            ...(typeof usage.completion_tokens === "number"
              ? { outputTokens: usage.completion_tokens }
              : {}),
          },
        }),
  };
}

class OpenAiTextClient {
  public constructor(
    protected readonly apiKey: string,
    protected readonly modelId: string,
    public readonly capability: CapabilityMetadata,
    protected readonly fetcher: FetchImplementation = fetch,
  ) {}

  protected async completeJson(request: LlmRequest): Promise<LlmResponse> {
    const body = await requestJson(
      this.fetcher,
      this.apiKey,
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            ...(request.systemPrompt === undefined
              ? []
              : [{ role: "system", content: request.systemPrompt }]),
            { role: "user", content: request.prompt },
          ],
          response_format: { type: "json_object" },
        }),
      },
      60_000,
      request.correlationId,
    );
    return {
      output: jsonOutput(body, request.correlationId),
      metadata: provenance(this.modelId, body),
      ...(typeof body.id === "string" ? { providerRequestId: body.id } : {}),
    };
  }
}

export class OpenAiIdeaProposalLlm extends OpenAiTextClient implements IdeaProposalLlmPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("idea-proposal", modelId, 2), fetcher);
  }
  public async proposeIdea(
    input: Readonly<{ prompt: string; context?: string; correlationId: string }>,
  ): Promise<IdeaProposalResult> {
    const result = await this.completeJson({
      prompt: `${input.prompt}\n${input.context ?? ""}`,
      correlationId: input.correlationId,
    });
    return {
      proposal: result.output as IdeaProposalResult["proposal"],
      metadata: result.metadata as LlmCompletionMetadata,
    };
  }
}

export class OpenAiScriptLlm extends OpenAiTextClient implements LlmProviderPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("script", modelId, 2), fetcher);
  }
  public complete(request: LlmRequest): Promise<LlmResponse> {
    return this.completeJson(request);
  }
}

export class OpenAiQualityReviewPort extends OpenAiTextClient implements QualityReviewPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("quality-review", modelId, 2), fetcher);
  }
  public async review(request: QualityReviewRequest): Promise<QualityReviewResult> {
    const result = await this.completeJson({
      prompt: JSON.stringify(request),
      correlationId: request.correlationId,
    });
    return { ...(result.output as QualityReviewResult), metadata: result.metadata };
  }
}

export class OpenAiInsightReportLlm extends OpenAiTextClient implements InsightReportLlmPort {
  public constructor(apiKey: string, modelId: string, fetcher: FetchImplementation = fetch) {
    super(apiKey, modelId, textCapability("insight-report", modelId, 2), fetcher);
  }
  public isConfigured(): boolean {
    return true;
  }
  public async generate(input: InsightNarrativeInput): Promise<InsightNarrativeResult> {
    const correlationId = input.correlationId ?? "insight-adapter";
    const result = await this.completeJson({ prompt: JSON.stringify(input), correlationId });
    const output = result.output;
    if (
      typeof output !== "object" ||
      output === null ||
      typeof (output as JsonRecord).narrative !== "string"
    )
      throw new ProviderError("UNKNOWN", "OpenAI insight response is invalid", correlationId);
    return { narrative: (output as JsonRecord).narrative as string, provenance: result.metadata };
  }
}

export class OpenAiImageProvider implements ImageProviderPort {
  public readonly capability: CapabilityMetadata;
  public constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetcher: FetchImplementation = fetch,
  ) {
    this.capability = mediaCapability("image-generation", "image", modelId, 10);
  }
  public async generate(request: ImageRequest): Promise<MediaGenerationResponse> {
    const body = await requestJson(
      this.fetcher,
      this.apiKey,
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelId,
          prompt: request.prompt,
          response_format: "b64_json",
          n: 1,
        }),
      },
      120_000,
      request.correlationId,
    );
    const first = Array.isArray(body.data) ? body.data[0] : undefined;
    if (typeof first !== "object" || first === null)
      throw new ProviderError("UNKNOWN", "OpenAI image response is invalid", request.correlationId);
    const encoded = (first as JsonRecord).b64_json;
    if (typeof encoded !== "string")
      throw new ProviderError(
        "UNKNOWN",
        "OpenAI image response has no bytes",
        request.correlationId,
      );
    return {
      mediaId: typeof body.id === "string" ? body.id : request.correlationId,
      ...(typeof body.id === "string" ? { providerRequestId: body.id } : {}),
      metadata: { modelVersion: this.modelId, promptVersion: "openai-images-v1", cost: null },
      media: {
        declaredMediaType: "image/png",
        body: Uint8Array.from(Buffer.from(encoded, "base64")),
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
    this.capability = mediaCapability("tts", "tts", modelId, 1);
  }
  public async synthesize(request: TtsRequest): Promise<MediaGenerationResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.fetcher(`${OPENAI_API}/audio/speech`, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelId,
          input: request.text,
          voice: request.voice,
          response_format: "mp3",
        }),
      });
      if (!response.ok)
        throw providerError(response.status, "OpenAI TTS request failed", request.correlationId);
      const requestId = response.headers.get("x-request-id");
      return {
        mediaId: requestId ?? request.correlationId,
        ...(requestId === null ? {} : { providerRequestId: requestId }),
        metadata: { modelVersion: this.modelId, promptVersion: "openai-tts-v1", cost: null },
        media: {
          declaredMediaType: "audio/mpeg",
          body: new Uint8Array(await response.arrayBuffer()),
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "OpenAI TTS request failed",
        request.correlationId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OpenAiVideoProvider implements VideoProviderPort {
  public readonly capability: CapabilityMetadata;
  public constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly fetcher: FetchImplementation = fetch,
  ) {
    this.capability = mediaCapability("video", "video", modelId, 100, true);
  }
  public async generate(request: VideoRequest): Promise<MediaGenerationResponse> {
    const submitted =
      request.providerJobId === undefined
        ? await requestJson(
            this.fetcher,
            this.apiKey,
            "/videos",
            {
              method: "POST",
              body: JSON.stringify({
                model: this.modelId,
                prompt: request.prompt,
                seconds: String(request.durationSeconds),
                size: "1280x720",
              }),
            },
            30_000,
            request.correlationId,
          )
        : { id: request.providerJobId, status: "queued" };
    const jobId = stringValue(submitted.id, "video job id", request.correlationId);
    const deadline = Date.now() + 15 * 60_000;
    let job: JsonRecord = submitted;
    while (Date.now() <= deadline) {
      const status = typeof job.status === "string" ? job.status : "queued";
      if (status === "completed") break;
      if (status === "failed" || status === "canceled")
        throw new ProviderError(
          "PROVIDER_REJECTED",
          "OpenAI video job failed",
          request.correlationId,
        );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      job = await requestJson(
        this.fetcher,
        this.apiKey,
        `/videos/${jobId}`,
        { method: "GET" },
        30_000,
        request.correlationId,
      );
    }
    if (job.status !== "completed")
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "OpenAI video job timed out",
        request.correlationId,
      );
    const response = await this.fetcher(`${OPENAI_API}/videos/${jobId}/content`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw providerError(
        response.status,
        "OpenAI video content request failed",
        request.correlationId,
      );
    return {
      mediaId: jobId,
      providerJobId: jobId,
      providerRequestId: jobId,
      metadata: {
        modelVersion: this.capability.capabilityId,
        promptVersion: "openai-video-v1",
        cost: null,
      },
      media: { declaredMediaType: "video/mp4", body: new Uint8Array(await response.arrayBuffer()) },
    };
  }
}

export function openAiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
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
export function openAiVideoModel(env: NodeJS.ProcessEnv = process.env): string {
  return model(env, "OPENAI_VIDEO_MODEL", DEFAULT_VIDEO_MODEL);
}
