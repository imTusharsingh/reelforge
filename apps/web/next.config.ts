import { resolve } from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  const configured = process.env.REELFORGE_API_ORIGIN?.trim();
  if (phase === PHASE_PRODUCTION_BUILD && !configured)
    throw new Error("REELFORGE_API_ORIGIN is required for a production build");
  const url = new URL(configured ?? "http://localhost:3001");
  if (!["http:", "https:"].includes(url.protocol) || url.href !== url.origin + "/")
    throw new Error("REELFORGE_API_ORIGIN must be an HTTP(S) origin");
  return {
    turbopack: {
      root: resolve(__dirname, "../.."),
      resolveAlias: {
        "./foundations.js": "../../packages/contracts/src/foundations.ts",
        "./brief-consistency.js": "../../packages/contracts/src/brief-consistency.ts",
        "./narrator-voice.js": "../../packages/contracts/src/narrator-voice.ts",
      },
    },
    async rewrites(): Promise<{ source: string; destination: string }[]> {
      return [
        {
          source: "/api/v1/:path*",
          destination: `${url.origin}/api/v1/:path*`,
        },
      ];
    },
  };
}
