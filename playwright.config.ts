import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3300",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 40_000,
    screenshot: "only-on-failure",
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },
  projects: [
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: [
    {
      command: "exec node node_modules/vitest/vitest.mjs run --config e2e/server.config.ts",
      url: "http://127.0.0.1:3301/api/v1/health",
      timeout: 120_000,
      env: { NODE_ENV: "test", WEB_APP_ORIGIN: "http://127.0.0.1:3300" },
    },
    {
      command:
        "exec node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3300",
      url: "http://127.0.0.1:3300",
      timeout: 120_000,
      env: {
        NODE_ENV: "development",
        REELFORGE_API_ORIGIN: "http://127.0.0.1:3301",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
