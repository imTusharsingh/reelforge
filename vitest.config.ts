import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run before workspace builds in CI; resolve the workspace package to
    // its TypeScript source instead of requiring generated dist artifacts.
    alias: {
      "@reelforge/config-engine": new URL("./packages/config-engine/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
