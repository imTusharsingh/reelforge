import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "@playwright/test";
import { buildBrowserFixture } from "./browser-bundle.mjs";

const { js } = await buildBrowserFixture();
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
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await page.goto(`${origin}/?mode=csrf`);
  await page.getByLabel("Email address").fill("creator@example.com");
  await page.getByLabel("Password").fill("password-123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await page.getByLabel("Display name").fill("Updated Creator");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Profile updated.").waitFor();
  const calls = await page.evaluate(() => window.m22Fixture.calls);
  const csrfIndex = calls.findIndex((call) => call.path === "/auth/csrf");
  const loginIndex = calls.findIndex(
    (call) => call.path === "/auth/login" && call.method === "POST",
  );
  assert(csrfIndex >= 0 && loginIndex > csrfIndex);
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
