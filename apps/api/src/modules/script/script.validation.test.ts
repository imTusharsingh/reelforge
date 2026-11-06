import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
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
  it("rejects factual documents without sources", () => {
    expect(() =>
      validateScript({ ...document, metadata: { ...document.metadata, factual: true } }),
    ).toThrow(BadRequestException);
  });
});
