import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiLegacyImage, GeminiLegacyTts, geminiLegacyText } from "./gemini.legacy.js";
import {
  openAiRuntimeConfig,
  openAiKey,
  openAiTextModel,
  OpenAiScriptLlm,
} from "./openai.adapters.js";
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function media(type: string): Record<string, unknown> {
  return {
    id: "job",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type, mime_type: type === "image" ? "image/png" : "audio/wav", data: "YWJj" }],
      },
    ],
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("old-flow Gemini bindings", () => {
  it("never forwards an OpenAI fallback credential to Gemini media", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENAI_API_KEY", "openai-only-secret");
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetcher = vi.fn<typeof fetch>();
    const image = new GeminiLegacyImage("openai-only-secret", "configured-image", fetcher);
    await expect(image.generate({ prompt: "pond", correlationId: "id" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      providerCalled: false,
    });
    const tts = new GeminiLegacyTts("openai-only-secret", "configured-tts", fetcher);
    await expect(
      tts.synthesize({ text: "hi", voice: "Kore", correlationId: "id" }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", providerCalled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rebinds image and TTS to Gemini without OpenAI endpoints or old models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(media("image")))
      .mockResolvedValueOnce(json(media("audio")));
    const image = new GeminiLegacyImage("gemini-secret", "configured-image", fetcher);
    const tts = new GeminiLegacyTts("gemini-secret", "configured-tts", fetcher);
    expect((await image.generate({ prompt: "pond", correlationId: "id" })).media.body).toEqual(
      new Uint8Array([97, 98, 99]),
    );
    expect(
      (await tts.synthesize({ text: "hi", voice: "Kore", correlationId: "id" })).media
        .declaredMediaType,
    ).toBe("audio/wav");
    expect(image.capability.providerId).toBe("gemini");
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).includes("generativelanguage.googleapis.com"),
      ),
    ).toBe(true);
    expect(() =>
      image.generate({ prompt: "p", correlationId: "id", referenceImageIds: ["ref"] }),
    ).toThrow("V5");
    await expect(image.generate({ prompt: "", correlationId: "id" })).rejects.toMatchObject({
      providerCalled: false,
    });
  });
  it("rejects refusal, timeout, missing outputs and malformed media", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const image = new GeminiLegacyImage("secret", "model", fetcher);
    for (const body of [
      { status: "refused" },
      { status: "queued" },
      { status: "completed", steps: [] },
      {
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "image", data: "bad" }] }],
      },
    ]) {
      fetcher.mockResolvedValueOnce(json(body));
      await expect(image.generate({ prompt: "p", correlationId: "id" })).rejects.toMatchObject({
        providerCalled: true,
      });
    }
    fetcher.mockRejectedValueOnce(new Error("timeout"));
    await expect(image.generate({ prompt: "p", correlationId: "id" })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
  it("routes primary text to Gemini and makes OpenAI fallback explicit", async () => {
    expect(
      openAiRuntimeConfig({ NODE_ENV: "test", GEMINI_API_KEY: "secret", OPENAI_API_KEY: "other" })
        .key,
    ).toBeUndefined();
    expect(openAiRuntimeConfig({ OPENAI_API_KEY: "secret" }).key).toBeUndefined();
    expect(
      openAiRuntimeConfig({
        OPENAI_API_KEY: "secret",
        OPENAI_TEXT_FALLBACK_ENABLED: "true",
        OPENAI_TEXT_MODEL: "current",
      }),
    ).toMatchObject({ key: "secret", textModel: "current", textFallbackEnabled: true });
    expect(openAiTextModel({})).toBe("");
    expect(openAiKey({ NODE_ENV: "test", OPENAI_API_KEY: "x" })).toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "gemini");
    const config = openAiRuntimeConfig({
      NODE_ENV: "production",
      GEMINI_API_KEY: "gemini",
      GEMINI_TEXT_MODEL: "text",
      GEMINI_IMAGE_MODEL: "image",
      GEMINI_TTS_MODEL: "tts",
    });
    expect(config).toMatchObject({ key: "gemini", textFallbackEnabled: true, imageModel: "image" });
    const response = {
      id: "job",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"title":"script"}' }] }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
    const script = new OpenAiScriptLlm("gemini", "text", fetcher);
    expect(script.capability.providerId).toBe("gemini");
    expect((await script.complete({ prompt: "write", correlationId: "id" })).output).toEqual({
      title: "script",
    });
    await expect(
      geminiLegacyText(
        "gemini",
        "text",
        vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
        { prompt: "write", correlationId: "id" },
        "system",
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
