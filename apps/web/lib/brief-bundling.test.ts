import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import nextConfig from "../next.config";
afterEach(() => vi.unstubAllEnvs());
describe("V7 contracts bundling", () => {
  it("requires an explicit HTTP(S) API origin for a production build", async () => {
    vi.stubEnv("REELFORGE_API_ORIGIN", "");
    expect(() => nextConfig(PHASE_PRODUCTION_BUILD)).toThrow("REELFORGE_API_ORIGIN is required");
    vi.stubEnv("REELFORGE_API_ORIGIN", "https://api.example.test/path");
    expect(() => nextConfig(PHASE_PRODUCTION_BUILD)).toThrow("must be an HTTP(S) origin");
    vi.stubEnv("REELFORGE_API_ORIGIN", "https://api.example.test");
    expect(await nextConfig(PHASE_PRODUCTION_BUILD).rewrites?.()).toEqual([
      { source: "/api/v1/:path*", destination: "https://api.example.test/api/v1/:path*" },
    ]);
  });
  it("resolves the V1 ESM specifier to the original TypeScript source for the web bundle", async () => {
    const config = nextConfig(PHASE_DEVELOPMENT_SERVER);
    expect(config.turbopack?.resolveAlias).toEqual({
      "./foundations.js": "../../packages/contracts/src/foundations.ts",
      "./brief-consistency.js": "../../packages/contracts/src/brief-consistency.ts",
      "./narrator-voice.js": "../../packages/contracts/src/narrator-voice.ts",
    });
    expect(config.turbopack?.root).toBe(
      resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    );
    const rewrites = await config.rewrites?.();
    expect(rewrites).toEqual([
      { source: "/api/v1/:path*", destination: expect.stringMatching(/\/api\/v1\/:path\*$/) },
    ]);
  });
});
