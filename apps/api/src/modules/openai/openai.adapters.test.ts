import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@reelforge/ai-providers";
import {
  OpenAiImageProvider,
  OpenAiQualityReviewPort,
  OpenAiVideoProvider,
  OpenAiTtsProvider,
  openAiKey,
} from "./openai.adapters.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI adapters", () => {
  it("maps a quality JSON response and sends the correlation id in the request input", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "req_1",
        choices: [
          {
            message: {
              content:
                '{"criteria":{},"metadata":{"modelVersion":"m","promptVersion":"p","cost":null}}',
            },
          },
        ],
      }),
    );
    const adapter = new OpenAiQualityReviewPort("secret", "text-model", fetcher);
    const result = await adapter.review({
      correlationId: "00000000-0000-4000-8000-000000000001",
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
    expect(result.metadata.modelVersion).toBe("text-model");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "text-model",
    });
  });

  it("maps provider failures without exposing the response body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "secret response" }, 429));
    await expect(
      new OpenAiImageProvider("secret", "image-model", fetcher).generate({
        prompt: "p",
        correlationId: "c",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    try {
      await new OpenAiImageProvider("secret", "image-model", fetcher).generate({
        prompt: "p",
        correlationId: "c",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).not.toContain("secret response");
    }
  });

  it("aborts an image request at its adapter timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = new OpenAiImageProvider("secret", "image-model", fetcher).generate({
      prompt: "p",
      correlationId: "c",
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    vi.useRealTimers();
  });

  it("maps image bytes and TTS bytes from fake HTTP responses", async () => {
    const image = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ id: "img_1", data: [{ b64_json: Buffer.from("png").toString("base64") }] }),
      );
    const imageResult = await new OpenAiImageProvider("secret", "image-model", image).generate({
      prompt: "p",
      correlationId: "c",
    });
    expect(new TextDecoder().decode(imageResult.media.body)).toBe("png");
    const tts = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new TextEncoder().encode("audio"), {
        status: 200,
        headers: { "x-request-id": "tts_1" },
      }),
    );
    const ttsResult = await new OpenAiTtsProvider("secret", "tts-model", tts).synthesize({
      text: "hello",
      voice: "alloy",
      correlationId: "c",
    });
    expect(new TextDecoder().decode(ttsResult.media.body)).toBe("audio");
  });

  it("resumes video polling from a stored provider job without submitting again", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "job_1", status: "completed" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }));
    const promise = new OpenAiVideoProvider("secret", "video-model", fetcher).generate({
      prompt: "p",
      durationSeconds: 5,
      correlationId: "c",
      providerJobId: "job_1",
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toContain("/videos/job_1");
    expect(result.providerJobId).toBe("job_1");
    vi.useRealTimers();
  });

  it("keeps OpenAI unconfigured when the key is absent", () => {
    expect(openAiKey({ OPENAI_API_KEY: "" })).toBeUndefined();
    expect(openAiKey({ OPENAI_API_KEY: "  " })).toBeUndefined();
  });
});
