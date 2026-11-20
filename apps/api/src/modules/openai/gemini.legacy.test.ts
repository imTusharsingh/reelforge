import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiRuntimeConfig, openAiKey, openAiTextModel } from "./openai.adapters.js";
afterEach(() => vi.unstubAllEnvs());
describe("Insight narration text configuration", () => {
  it("selects Gemini text and makes OpenAI fallback explicit", async () => {
    expect(
      openAiRuntimeConfig({ NODE_ENV: "test", GEMINI_API_KEY: "secret", OPENAI_API_KEY: "other" })
        .key,
    ).toBe("secret");
    expect(openAiRuntimeConfig({ OPENAI_API_KEY: "secret" }).key).toBeUndefined();
    expect(
      openAiRuntimeConfig({
        OPENAI_API_KEY: "secret",
        OPENAI_TEXT_FALLBACK_ENABLED: "true",
        OPENAI_TEXT_MODEL: "current",
      }),
    ).toMatchObject({ key: "secret", textModel: "current", textFallbackEnabled: true });
    expect(openAiTextModel({})).toBe("");
    expect(openAiKey({ NODE_ENV: "test", OPENAI_API_KEY: "x" })).toBe("x");
    const config = openAiRuntimeConfig({
      NODE_ENV: "production",
      GEMINI_API_KEY: "gemini",
      GEMINI_TEXT_MODEL: "text",
      GEMINI_IMAGE_MODEL: "image",
      GEMINI_TTS_MODEL: "tts",
    });
    expect(config).toMatchObject({ key: "gemini", textFallbackEnabled: true, imageModel: "image" });
  });
});
