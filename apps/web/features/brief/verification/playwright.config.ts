import { defineConfig } from "@playwright/test";
import root from "../../../../../playwright.config";
export default defineConfig({
  ...root,
  testDir: ".",
  testMatch: "browser.spec.ts",
  webServer: (Array.isArray(root.webServer) ? root.webServer : [root.webServer!]).map((server) => ({
    ...server,
    cwd: process.cwd(),
  })),
});
