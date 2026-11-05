import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { validateUploadPayload } from "./asset.validation.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("asset upload validation", () => {
  it.each([
    ["empty body", Buffer.alloc(0), "image/png", "empty.png", 100],
    ["wrong MIME", png, "image/jpeg", "image.jpg", 100],
    ["oversized body", png, "image/png", "image.png", 7],
  ])("rejects %s with an actionable error", (_caseName, body, mediaType, filename, maxBytes) => {
    expect(() => validateUploadPayload({ body, declaredMediaType: mediaType, filename }, maxBytes)).toThrow(
      BadRequestException,
    );
  });
});
