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
export function providerKey(
  vendor: "gemini" | "xai",
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.NODE_ENV === "test") return undefined;
  return env[vendor === "gemini" ? "GEMINI_API_KEY" : "XAI_API_KEY"]?.trim() || undefined;
}
