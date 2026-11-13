import assert from "node:assert/strict";
import fs from "node:fs";
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
  outdir: "/tmp/m22-account-browser",
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
const css = output.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
const global = fs
  .readFileSync(path.join(root, "apps/web/app/globals.css"), "utf8")
  .replace(/@import[^;]+;/g, "");
const tokens = fs.readFileSync(path.join(root, "apps/web/styles/design-tokens.css"), "utf8");

const server = http.createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/bundle.js"
      ? "application/javascript"
      : request.url === "/style.css"
        ? "text/css"
        : "text/html",
  );
  response.end(
    request.url === "/bundle.js"
      ? js
      : request.url === "/style.css"
        ? tokens + global + css
        : '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
});
let count = 0;

async function test(name, run, query = "", viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
  try {
    await run(page);
    count += 1;
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}

try {
  for (const width of [390, 1440]) {
    await test(
      `profile save and password success at ${width}px`,
      async (page) => {
        await page.getByRole("heading", { name: "Profile and security" }).waitFor();
        await page.getByLabel("Display name").fill("  Updated Creator  ");
        await page.getByRole("button", { name: "Save profile" }).click();
        await page.getByText("Profile updated.").waitFor();
        const calls = await page.evaluate(() => window.m22Fixture.calls);
        assert(
          calls.some(
            (c) =>
              c.method === "PATCH" &&
              c.path === "/auth/me" &&
              c.body.displayName === "  Updated Creator  ",
          ),
        );

        await page.getByLabel("Current password").fill("current-password-123");
        await page.getByLabel("New password", { exact: true }).fill("new-password-12345");
        await page.getByLabel("Confirm new password").fill("new-password-12345");
        await page.getByRole("button", { name: "Change password" }).click();
        await page.getByText("Password changed. 2 other sessions were signed out.").waitFor();
        assert.equal(
          await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
          true,
        );
      },
      "mode=account",
      { width, height: 900 },
    );
  }

  await test("password change shows clear 401, 429 and 400 states", async (page) => {
    await page.getByRole("heading", { name: "Profile and security" }).waitFor();

    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=password-401`);
    await page.getByRole("heading", { name: "Profile and security" }).waitFor();
    await page.getByLabel("Current password").fill("wrong-password-12345");
    await page.getByLabel("New password", { exact: true }).fill("new-password-12345");
    await page.getByLabel("Confirm new password").fill("new-password-12345");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByText("Current password is incorrect.").waitFor();

    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=password-429`);
    await page.getByRole("heading", { name: "Profile and security" }).waitFor();
    await page.getByLabel("Current password").fill("current-password-123");
    await page.getByLabel("New password", { exact: true }).fill("new-password-12345");
    await page.getByLabel("Confirm new password").fill("new-password-12345");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByText("Too many attempts. Try again later.").waitFor();

    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=password-400`);
    await page.getByRole("heading", { name: "Profile and security" }).waitFor();
    await page.getByLabel("Current password").fill("current-password-123");
    await page.getByLabel("New password", { exact: true }).fill("new-password-12345");
    await page.getByLabel("Confirm new password").fill("new-password-12345");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByText(/New password must differ|Check the form and try again/).waitFor();
  });

  await test(
    "forgot password is shown as unavailable on login",
    async (page) => {
      await page.getByRole("heading", { name: "Welcome back." }).waitFor();
      await page
        .getByText(
          "Forgot password? Password reset isn't available yet. Contact your workspace owner.",
        )
        .waitFor();
      assert.equal(await page.locator('a:has-text("Forgot password")').count(), 0);
      assert.equal(
        await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
        true,
      );
    },
    "mode=login",
    { width: 390, height: 844 },
  );

  console.log(`PASS ${count} mounted account browser scenarios`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
