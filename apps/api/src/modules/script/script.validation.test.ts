import { describe, expect, it } from "vitest";
import { parseScriptDocument, validateScript } from "./script.validation.js";

const document = {
  schemaVersion: "1.0" as const,
  title: "T",
  hook: "H",
  dialogue: "D",
  cta: "C",
  metadata: { genre: "comedy", targetDurationSeconds: 2, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 2,
      characterRefs: [],
      dialogue: "D",
      visualDescription: "V",
      camera: "wide",
      audioCues: [],
    },
  ],
};
describe("script validation", () => {
  it("accepts a duration-valid structured document", () => {
    validateScript(parseScriptDocument(document));
  });
  it("keeps structural validation independent of genre-driven factuality", () => {
    expect(() =>
      validateScript({ ...document, metadata: { ...document.metadata, factual: true } }),
    ).not.toThrow();
  });
});

describe("genre-driven factuality", () => {
  it("requires source-backed claims when genre policy requires them", async () => {
    const { validateGenrePolicy } = await import("./script.validation.js");
    const factualDocument = parseScriptDocument({
      ...document,
      metadata: { ...document.metadata, factual: true },
    });
    expect(() =>
      validateGenrePolicy(
        factualDocument,
        { safetyProfile: { requiresSourceBackedClaims: true } },
        [],
      ),
    ).toThrow("approved idea source");
  });

  it("rejects a provider factual flag that disagrees with genre policy", async () => {
    const { validateGenrePolicy } = await import("./script.validation.js");
    const factualDocument = parseScriptDocument(document);
    expect(() =>
      validateGenrePolicy(
        factualDocument,
        { safetyProfile: { requiresSourceBackedClaims: true } },
        [],
      ),
    ).toThrow("Genre factuality");
  });
});
