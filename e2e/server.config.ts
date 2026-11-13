import { defineConfig } from "vitest/config";
import root from "../vitest.config.ts";
export default defineConfig({
  resolve: root.resolve ?? {},
  test: { include: ["apps/api/e2e/server.fixture.ts"], fileParallelism: false, testTimeout: 0 },
});
