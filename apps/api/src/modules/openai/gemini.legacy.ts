import {
  ProviderError,
  ProviderHttp,
  Interactions,
  GeminiText,
  ProviderFailure,
  record,
  requiredString,
  type CapabilityMetadata,
  type ImageProviderPort,
  type ImageRequest,
  type TtsProviderPort,
  type TtsRequest,
  type MediaGenerationResponse,
  type LlmRequest,
  type LlmResponse,
} from "@reelforge/ai-providers";

function client(key: string, fetcher: typeof fetch): Interactions {
  return new Interactions(new ProviderHttp(key, "gemini", fetcher, 120000), {
    save: async (): Promise<never> => {
      throw new Error("Legacy flow stores media through M04");
    },
  });
}
export async function geminiLegacyText(
  key: string,
  model: string,
  fetcher: typeof fetch,
  request: LlmRequest,
  systemPrompt: string,
): Promise<LlmResponse> {
  try {
    const result = await new GeminiText(client(key, fetcher), model).complete(
      { prompt: request.prompt, systemPrompt, jsonSchema: { type: "object" }, parse: record },
      request.correlationId,
    );
    return {
      output: result.output,
      providerRequestId: result.providerJobId,
      metadata: { modelVersion: model, promptVersion: "gemini-interactions-v1", cost: null },
    };
  } catch (error) {
    throw legacyFailure(error, request.correlationId);
  }
}
function legacyFailure(error: unknown, correlationId: string): ProviderError {
  const failure = error instanceof ProviderFailure ? error : new ProviderFailure("INVALID", true);
  return new ProviderError(
    failure.kind === "NOT_CONFIGURED"
      ? "NOT_CONFIGURED"
      : failure.kind === "OUTAGE" || failure.kind === "RATE_LIMIT"
        ? "PROVIDER_UNAVAILABLE"
        : "PROVIDER_REJECTED",
    failure.message,
    correlationId,
    { providerCalled: failure.dispatched },
  );
}
function capability(kind: "image" | "tts"): CapabilityMetadata {
  return {
    providerId: "gemini",
    capabilityId: kind === "image" ? "image-generation" : "tts",
    kind,
    input: ["text"],
    output: [kind === "image" ? "image/png" : "audio/wav"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: ["global"],
    costModel: { currency: "USD", unit: "request", amount: kind === "image" ? 0.0336 : 0.1 },
  };
}
abstract class LegacyMedia {
  public readonly capability: CapabilityMetadata;
  public constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch,
    private readonly kind: "image" | "tts",
  ) {
    this.key = process.env.NODE_ENV === "test" ? key : process.env.GEMINI_API_KEY?.trim() || "";
    this.capability = capability(kind);
  }
  protected async generateMedia(
    input: string,
    correlationId: string,
    voice?: string,
  ): Promise<MediaGenerationResponse> {
    if (
      !input.trim() ||
      !this.model.trim() ||
      !this.key.trim() ||
      (this.kind === "tts" && !voice?.trim())
    )
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Gemini media configuration or input missing",
        correlationId,
        { providerCalled: false },
      );
    try {
      const interaction = client(this.key, this.fetcher);
      const response = await interaction.result(
        {
          model: this.model,
          input,
          response_format: { type: this.kind === "image" ? "image" : "audio" },
          ...(voice ? { generation_config: { speech_config: [{ voice }] } } : {}),
        },
        correlationId,
      );
      if (response.status === "refused") throw new ProviderFailure("REFUSAL", true);
      if (response.status !== "completed") throw new ProviderFailure("INVALID", true);
      const output = interaction
        .outputs(response)
        .find((item) => item.type === (this.kind === "image" ? "image" : "audio"));
      if (!output) throw new ProviderFailure("INVALID", true);
      const id = requiredString(response.id);
      const data = requiredString(output.data);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0)
        throw new ProviderFailure("INVALID", true);
      return {
        mediaId: id,
        providerRequestId: id,
        metadata: { modelVersion: this.model, promptVersion: "gemini-interactions-v1", cost: null },
        media: {
          declaredMediaType: requiredString(output.mime_type),
          body: new Uint8Array(Buffer.from(data, "base64")),
        },
      };
    } catch (error) {
      throw legacyFailure(error, correlationId);
    }
  }
}
export class GeminiLegacyImage extends LegacyMedia implements ImageProviderPort {
  public constructor(key: string, model: string, fetcher: typeof fetch = fetch) {
    super(key, model, fetcher, "image");
  }
  public generate(request: ImageRequest): Promise<MediaGenerationResponse> {
    if (request.referenceImageIds?.length)
      throw new ProviderError(
        "INVALID_REQUEST",
        "Legacy references require V5",
        request.correlationId,
        { providerCalled: false },
      );
    return this.generateMedia(request.prompt, request.correlationId);
  }
}
export class GeminiLegacyTts extends LegacyMedia implements TtsProviderPort {
  public constructor(key: string, model: string, fetcher: typeof fetch = fetch) {
    super(key, model, fetcher, "tts");
  }
  public synthesize(request: TtsRequest): Promise<MediaGenerationResponse> {
    return this.generateMedia(request.text, request.correlationId, request.voice);
  }
}
