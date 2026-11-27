const aliases = new Map([
  ["english", "eng"],
  ["en", "eng"],
  ["hindi", "hin"],
  ["hi", "hin"],
  ["spanish", "spa"],
  ["es", "spa"],
  ["french", "fra"],
  ["fr", "fra"],
  ["german", "deu"],
  ["de", "deu"],
  ["italian", "ita"],
  ["it", "ita"],
]);

export class NarrationLanguageUnavailable extends Error {
  public constructor() {
    super(
      "Narration language cannot be aligned locally. Choose a supported language name or ISO 639-3 code with an installed eSpeak voice.",
    );
  }
}

/** Match both the aligner's ISO codes and what this process actually has voice data for. */
export function alignmentLanguage(value: unknown, installed?: ReadonlySet<string>): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  const code = aliases.get(normalized) ?? normalized;
  if (!/^[a-z]{3}$/u.test(code) || (installed && !installed.has(code)))
    throw new NarrationLanguageUnavailable();
  return code;
}
