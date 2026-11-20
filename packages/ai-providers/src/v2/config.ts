export type ProviderModels = Readonly<{
  video: string;
  image: string;
  text: string;
  tts: string;
  music: string;
  xaiVideo: string;
}>;
export function providerModels(env: Record<string, string | undefined>): ProviderModels {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing provider model configuration: ${name}`);
    return value;
  };
  return {
    video: read("GEMINI_VIDEO_MODEL"),
    image: read("GEMINI_IMAGE_MODEL"),
    text: read("GEMINI_TEXT_MODEL"),
    tts: read("GEMINI_TTS_MODEL"),
    music: read("GEMINI_MUSIC_MODEL"),
    xaiVideo: read("XAI_VIDEO_MODEL"),
  };
}
// Gemini issues both standard keys and authorization keys.
const keyPrefixes = {
  gemini: /^(?:AIza|AQ\.)/,
  xai: /^xai-/,
  openai: /^sk-(?:(?:proj|svcacct)-)?/,
};

export function providerKeyIssue(
  vendor: keyof typeof keyPrefixes,
  key: string | undefined,
): "NOT_CONFIGURED" | "INVALID_KEY" | undefined {
  if (key === undefined || key === "") return "NOT_CONFIGURED";
  const prefix = key.match(keyPrefixes[vendor])?.[0];
  if (!prefix || /\s/.test(key)) return "INVALID_KEY";
  const payload = key.slice(prefix.length);
  if (
    !/^[A-Za-z0-9_-]{20,}$/.test(payload) ||
    /fake|placeholder|your[-_]?key|xxx|changeme/i.test(payload) ||
    /^[0_-]+$/.test(payload)
  )
    return "INVALID_KEY";
  return undefined;
}

export function providerKey(
  vendor: "gemini" | "xai",
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.NODE_ENV === "test") return undefined;
  return env[vendor === "gemini" ? "GEMINI_API_KEY" : "XAI_API_KEY"] || undefined;
}
