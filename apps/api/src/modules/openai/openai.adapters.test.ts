import { describe, expect, it, vi } from "vitest";
import { ProviderError, ProviderRegistry } from "@reelforge/ai-providers";
import {
  OPENAI_IMAGE_TIMEOUT_MS,
  OPENAI_TEXT_TIMEOUT_MS,
  OPENAI_TTS_TIMEOUT_MS,
  OpenAiIdeaProposalLlm,
  OpenAiImageProvider,
  OpenAiInsightReportLlm,
  OpenAiQualityReviewPort,
  OpenAiScriptLlm,
  OpenAiTtsProvider,
  openAiImageModel,
  openAiRuntimeConfig,
  openAiTextModel,
  openAiTtsModel,
} from "./openai.adapters.js";

const CORRELATION = "00000000-0000-4000-8000-000000000001";
const KEY = "sk-test-secret";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestBody(fetcher: ReturnType<typeof vi.fn>): unknown {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

const criterion = {
  score: 80,
  evidence: ["supported"],
  limitations: [],
};

describe("OpenAI adapters", () => {
  it("maps an idea proposal and sends the configured text model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Title",
                topic: "Topic",
                hook: "Hook",
                angle: "Angle",
                audience: "Audience",
                expectedFormat: "short-form-video",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const result = await new OpenAiIdeaProposalLlm(KEY, "text-model", fetcher).proposeIdea({
      prompt: "pitch",
      context: "brand",
      correlationId: CORRELATION,
    });
    expect(result.proposal.title).toBe("Title");
    expect(result.proposal.references).toEqual([]);
    expect(result.metadata).toMatchObject({
      modelVersion: "text-model",
      promptVersion: "openai-chat-completions-v1",
      cost: null,
    });
    expect(requestBody(fetcher)).toMatchObject({
      model: "text-model",
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(requestBody(fetcher))).toContain("pitch");
    expect(JSON.stringify(requestBody(fetcher))).not.toContain(KEY);
  });

  it("rejects an idea response that does not match the proposal schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"title":"only"}' } }] }));
    await expect(
      new OpenAiIdeaProposalLlm(KEY, "text-model", fetcher).proposeIdea({
        prompt: "pitch",
        correlationId: CORRELATION,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN", providerCalled: true });
  });

  it("maps a script object and refuses a per-request model override before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_script",
        choices: [{ message: { content: '{"schemaVersion":"1.0","title":"T"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const adapter = new OpenAiScriptLlm(KEY, "text-model", fetcher);
    const result = await adapter.complete({ prompt: "write JSON", correlationId: CORRELATION });
    expect(result.output).toMatchObject({ schemaVersion: "1.0", title: "T" });
    expect(result.providerRequestId).toBe("chatcmpl_script");
    expect(result.metadata.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    await expect(
      adapter.complete({ prompt: "write JSON", model: "other-model", correlationId: CORRELATION }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", providerCalled: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps a quality review and keeps adapter provenance instead of model metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_quality",
        choices: [
          {
            message: {
              content: JSON.stringify({
                criteria: {
                  FACTUALITY: criterion,
                  CLARITY: criterion,
                  COHERENCE: criterion,
                  ENGAGEMENT: criterion,
                  GENRE_FIT: criterion,
                },
              }),
            },
          },
        ],
      }),
    );
    const result = await new OpenAiQualityReviewPort(KEY, "text-model", fetcher).review({
      correlationId: CORRELATION,
      title: "t",
      hook: "h",
      dialogue: "d",
      narration: "n",
      callToAction: "c",
      genre: "g",
      allowedTopics: [],
      blockedTopics: [],
      claims: [],
      scenes: [],
      requiredDisclosures: [],
    });
    expect(result.criteria.FACTUALITY.score).toBe(80);
    expect(result.metadata.modelVersion).toBe("text-model");
    expect(result.metadata.promptVersion).toBe("openai-chat-completions-v1");
  });

  it("maps an insight narrative and rejects a response without one", async () => {
    const ok = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '{"narrative":"Views fell."}' } }] }),
      );
    const narrative = await new OpenAiInsightReportLlm(KEY, "text-model", ok).generate({
      correlationId: CORRELATION,
      channelId: "channel",
      currentWindow: { startDate: "2026-01-01", endDate: "2026-01-07" },
      previousWindow: { startDate: "2025-12-25", endDate: "2025-12-31" },
      kpis: [],
      dimensions: [],
    });
    expect(narrative.narrative).toBe("Views fell.");
    const bad = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"note":"no"}' } }] }));
    await expect(
      new OpenAiInsightReportLlm(KEY, "text-model", bad).generate({
        correlationId: CORRELATION,
        channelId: "channel",
        currentWindow: { startDate: "2026-01-01", endDate: "2026-01-07" },
        previousWindow: { startDate: "2025-12-25", endDate: "2025-12-31" },
        kpis: [],
        dimensions: [],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("maps image bytes without the legacy response_format field", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ b64_json: Buffer.from("png").toString("base64") }] }, 200, {
        "x-request-id": "img_req_1",
      }),
    );
    const result = await new OpenAiImageProvider(KEY, "image-model", fetcher).generate({
      prompt: "a poster",
      correlationId: CORRELATION,
    });
    expect(new TextDecoder().decode(result.media.body)).toBe("png");
    expect(result.providerRequestId).toBe("img_req_1");
    expect(result.metadata.modelVersion).toBe("image-model");
    const body = requestBody(fetcher) as { response_format?: string; output_format?: string };
    expect(body.response_format).toBeUndefined();
    expect(body).toMatchObject({
      model: "image-model",
      output_format: "png",
      size: "1024x1536",
    });
  });

  it("maps speech bytes and provider failures without the response body or key", async () => {
    const ok = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new TextEncoder().encode("audio"), {
        status: 200,
        headers: { "x-request-id": "tts_1" },
      }),
    );
    const speech = await new OpenAiTtsProvider(KEY, "tts-model", ok).synthesize({
      text: "hello",
      voice: "alloy",
      correlationId: CORRELATION,
    });
    expect(new TextDecoder().decode(speech.media.body)).toBe("audio");
    expect(speech.providerRequestId).toBe("tts_1");
    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: KEY + " secret response" } }, 400));
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "no" }, 429));
    await expect(
      new OpenAiTtsProvider(KEY, "tts-model", rejected).synthesize({
        text: "hello",
        voice: "alloy",
        correlationId: CORRELATION,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    await expect(
      new OpenAiImageProvider(KEY, "image-model", unavailable).generate({
        prompt: "p",
        correlationId: CORRELATION,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    try {
      await new OpenAiTtsProvider(KEY, "tts-model", rejected).synthesize({
        text: "hello",
        voice: "alloy",
        correlationId: CORRELATION,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).not.toContain("secret response");
    }
  });

  it("aborts text, image, and speech at their adapter timeouts", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const text = expect(
        new OpenAiScriptLlm(KEY, "text-model", hanging).complete({
          prompt: "p",
          correlationId: CORRELATION,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", providerCalled: true });
      await vi.advanceTimersByTimeAsync(OPENAI_TEXT_TIMEOUT_MS);
      await text;
      const image = expect(
        new OpenAiImageProvider(KEY, "image-model", hanging).generate({
          prompt: "p",
          correlationId: CORRELATION,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(OPENAI_IMAGE_TIMEOUT_MS);
      await image;
      const speech = expect(
        new OpenAiTtsProvider(KEY, "tts-model", hanging).synthesize({
          text: "hello",
          voice: "alloy",
          correlationId: CORRELATION,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(OPENAI_TTS_TIMEOUT_MS);
      await speech;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps OpenAI unbound without a key and does not advertise a video model by default", () => {
    expect(
      openAiRuntimeConfig({ OPENAI_API_KEY: "", NODE_ENV: "development" }).key,
    ).toBeUndefined();
    expect(
      openAiRuntimeConfig({ OPENAI_API_KEY: "  ", NODE_ENV: "development" }).key,
    ).toBeUndefined();
    expect(openAiRuntimeConfig({ OPENAI_API_KEY: KEY, NODE_ENV: "test" }).key).toBeUndefined();
    const configured = openAiRuntimeConfig({
      OPENAI_API_KEY: KEY,
      NODE_ENV: "development",
    });
    expect(configured.key).toBe(KEY);
    expect(configured.textFallbackEnabled).toBe(false);
    expect(
      openAiRuntimeConfig({
        OPENAI_API_KEY: KEY,
        OPENAI_TEXT_FALLBACK_ENABLED: "true",
        NODE_ENV: "development",
      }).textFallbackEnabled,
    ).toBe(true);
    expect(
      openAiRuntimeConfig({ OPENAI_TEXT_FALLBACK_ENABLED: "true", NODE_ENV: "test" })
        .textFallbackEnabled,
    ).toBe(false);
    expect(configured.textModel).toBe("gpt-4.1-mini");
    expect(configured.imageModel).toBe("gpt-image-2.6-sunburst");
    expect(configured.ttsModel).toBe("gpt-4o-mini-tts");
    expect(openAiTextModel({ OPENAI_TEXT_MODEL: " custom " })).toBe("custom");
    expect(openAiImageModel({})).toBe("gpt-image-2.6-sunburst");
    expect(openAiTtsModel({})).toBe("gpt-4o-mini-tts");
    const registry = new ProviderRegistry();
    const image = new OpenAiImageProvider(KEY, configured.imageModel);
    registry.register({
      capability: image.capability,
      credential: { providerId: "openai", environment: "development", secret: KEY },
    });
    expect(JSON.stringify(registry.list())).not.toContain(KEY);
  });
});
