import { describe, expect, it } from "vitest";
import { STARTER_ASSETS, starterAssetBody } from "./starter-assets.js";
import { sha256Hex } from "../asset/storage/checksum.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("starter character assets", () => {
  it("embeds valid, non-empty PNG bytes with documented CC0 rights", () => {
    for (const [key, definition] of Object.entries(STARTER_ASSETS)) {
      expect(definition.key).toBe(key);
      expect(definition.mediaType).toBe("image/png");
      expect(definition.licenseType).toBe("CC0-1.0");
      expect(definition.rightsHolder.length).toBeGreaterThan(0);
      const body = starterAssetBody(definition);
      expect(body.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(body.byteLength).toBeGreaterThan(100);
      expect(sha256Hex(body)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
