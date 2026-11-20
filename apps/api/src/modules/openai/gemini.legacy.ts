import {
  ProviderError,
  ProviderHttp,
  Interactions,
  GeminiText,
  ProviderFailure,
  record,
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
