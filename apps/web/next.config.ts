import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, "../.."),
    resolveAlias: { "./foundations.js": "../../packages/contracts/src/foundations.ts" },
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.REELFORGE_API_ORIGIN ?? "http://localhost:3001"}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
