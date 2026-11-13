import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const esbuild = require(process.env.ESBUILD_MODULE || "esbuild");
const root = path.resolve(directory, "../../../../..");
const output = await esbuild.build({
  entryPoints: [path.join(directory, "mounted-fixture.tsx")],
  bundle: true,
  write: false,
  outdir: "/tmp/reelforge-csrf-browser",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: {
    "next/link": path.join(root, "apps/web/features/planning/verification/next-link.tsx"),
    "next/navigation": path.join(
      root,
      "apps/web/features/production/verification/next-navigation.ts",
    ),
  },
});
const js = output.outputFiles.find((file) => file.path.endsWith(".js")).text;
const server = http.createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/bundle.js" ? "application/javascript" : "text/html",
  );
  response.end(
    request.url === "/bundle.js"
      ? js
      : '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await page.goto(`${origin}/?mode=csrf`);
  await page.getByLabel("Email address").fill("creator@example.com");
  await page.getByLabel("Password").fill("password-123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Continue to studio/ }).click();
  await page.getByLabel("Display name").fill("Updated Creator");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Profile updated.").waitFor();
  const calls = await page.evaluate(() => window.m22Fixture.calls);
  assert.equal(calls[0]?.path, "/auth/csrf");
  assert(calls.some((call) => call.path === "/auth/login" && call.method === "POST"));
  assert(calls.some((call) => call.path === "/auth/me" && call.method === "PATCH"));
  const rejected = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Missing token" }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.code, "CSRF_TOKEN_INVALID");
  console.log("PASS mounted CSRF sign-in, authenticated mutation, and rejection smoke");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
