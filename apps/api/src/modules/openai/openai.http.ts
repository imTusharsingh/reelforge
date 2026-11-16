import { ProviderError, type ProviderProvenance } from "@reelforge/ai-providers";
type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;
type OpenAiHttpResult = Readonly<{ body: JsonRecord; requestId: string | null }>;
const OPENAI_API = "https://api.openai.com/v1";
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function providerError(status: number, message: string, correlationId: string): ProviderError {
  const code =
    status === 408 || status === 429 || status >= 500
      ? "PROVIDER_UNAVAILABLE"
      : "PROVIDER_REJECTED";
  return new ProviderError(code, message, correlationId, {
    providerCalled: true,
  });
}

export function notSent(
  code: ProviderError["code"],
  message: string,
  correlationId: string,
): ProviderError {
  return new ProviderError(code, message, correlationId, { providerCalled: false });
}

export async function requestJson(
  fetcher: FetchImplementation,
  apiKey: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  correlationId: string,
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
      throw providerError(response.status, "OpenAI request failed", correlationId);
    }
    if (typeof body !== "object" || body === null) {
      throw new ProviderError("UNKNOWN", "OpenAI returned an invalid response", correlationId, {
        providerCalled: true,
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

export function jsonOutput(body: JsonRecord, correlationId: string): unknown {
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

export function provenance(modelVersion: string, body: JsonRecord): ProviderProvenance {
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

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
