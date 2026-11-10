import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run before workspace builds in CI; resolve the workspace package to
    // its TypeScript source instead of requiring generated dist artifacts.
    alias: {
      "@reelforge/config-engine": new URL("./packages/config-engine/src/index.ts", import.meta.url)
        .pathname,
      "@reelforge/ai-providers": new URL("./packages/ai-providers/src/index.ts", import.meta.url)
        .pathname,
      "@reelforge/database": new URL("./packages/database/src/index.ts", import.meta.url).pathname,
      "@reelforge/media": new URL("./packages/media/src/index.ts", import.meta.url).pathname,
      "@reelforge/observability": new URL("./packages/observability/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
