import { describe, expect, it } from "vitest";
import config from "../next.config";
describe("V7 contracts bundling", () => {
  it("resolves the V1 ESM specifier to the original TypeScript source for the web bundle", async () => {
    expect(config.turbopack?.resolveAlias).toEqual({
      "./foundations.js": "../../packages/contracts/src/foundations.ts",
    });
    expect(config.turbopack?.root).toMatch(/reelforge$/);
    const rewrites = await config.rewrites?.();
    expect(rewrites).toEqual([
      { source: "/api/v1/:path*", destination: expect.stringMatching(/\/api\/v1\/:path\*$/) },
    ]);
  });
});
