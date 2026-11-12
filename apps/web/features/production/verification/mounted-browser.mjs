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
  outdir: "/tmp/m25-browser",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: {
    "next/link": path.join(root, "apps/web/features/planning/verification/next-link.tsx"),
    "next/navigation": path.join(directory, "next-navigation.ts"),
  },
});
const js = output.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = output.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
const global = fs
  .readFileSync(path.join(root, "apps/web/app/globals.css"), "utf8")
  .replace(/@import[^;]+;/g, "");
const tokens = fs.readFileSync(path.join(root, "apps/web/styles/design-tokens.css"), "utf8");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const server = http.createServer((request, response) => {
  if (request.url?.includes("/content")) {
    response.setHeader(
      "Content-Type",
      request.url.includes("artifacts") ? "video/mp4" : "image/png",
    );
    response.statusCode = request.url.includes("artifacts")
      ? 410
      : request.url.includes("broken")
        ? 404
        : 200;
    response.end(
      request.url.includes("artifacts")
        ? "expired"
        : request.url.includes("broken")
          ? "missing"
          : png,
    );
    return;
  }
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
  await test("persisted scene timeline, narration and provider-unavailable controls", async (page) => {
    await page.getByRole("heading", { name: "The twenty-second reset" }).waitFor();
    assert.equal(await page.getByText("Latest revision must stay hidden").count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Regenerate entire scene" }).isDisabled(),
      true,
    );
    assert.equal(await page.getByRole("button", { name: "Select for scene" }).isDisabled(), true);
    await page.locator('button[aria-pressed="false"]').first().click();
    await page.getByText("One breath. One decision.", { exact: true }).waitFor();
    assert.equal(
      await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
      true,
    );
  });
  await test(
    "Viewer cannot mutate scene production",
    async (page) => {
      await page.getByRole("heading", { name: "The twenty-second reset" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Retry failed outputs" }).isDisabled(),
        true,
      );
    },
    "role=VIEWER",
  );
  await test(
    "mobile studio has no page overflow",
    async (page) => {
      await page.getByRole("heading", { name: "The twenty-second reset" }).waitFor();
      assert.equal(
        await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
        true,
      );
      await page.screenshot({ path: "/tmp/m25-production-mobile.png", fullPage: true });
    },
    "",
    { width: 390, height: 844 },
  );
  await test(
    "render uses authenticated artifact path and handles media failure",
    async (page) => {
      await page.getByRole("heading", { name: /Render/ }).waitFor();
      const download = page.getByRole("link", { name: "Download video" });
      assert((await download.getAttribute("href")).includes("/api/v1/workspaces/"));
      await page.getByText(/could not be loaded/).waitFor();
    },
    "mode=render",
  );
  await test(
    "media preview recovers when regenerated asset identity changes",
    async (page) => {
      await page.getByText(/Recoverable preview could not be loaded/).waitFor();
      await page.getByRole("button", { name: "Use regenerated asset" }).click();
      const preview = page.getByRole("img", { name: "Recoverable preview" });
      await preview.waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector("img")?.complete && document.querySelector("img")?.naturalWidth,
      );
      assert.equal(await page.getByText(/could not be loaded/).count(), 0);
    },
    "mode=media-recovery",
  );
  await test(
    "uncertain scene mutation reconciles with the same paid-work key",
    async (page) => {
      await page.getByRole("heading", { name: "The twenty-second reset" }).waitFor();
      await page.getByRole("button", { name: "Regenerate image" }).click();
      await page.getByText(/returned an unreadable response/).waitFor();
      await page.getByRole("button", { name: "Reconcile from server" }).click();
      await page.getByText(/Job version is now 4/).waitFor();
      const writes = await page.evaluate(() =>
        window.m25Fixture.calls.filter(
          (call) => call.method === "POST" && call.path.endsWith("/replace"),
        ),
      );
      assert.equal(writes.length, 2);
      assert.equal(writes[0].body.idempotencyKey, writes[1].body.idempotencyKey);
      assert.equal(writes[0].body.expectedJobVersion, writes[1].body.expectedJobVersion);
    },
    "mode=mutation-reconcile",
  );
  console.log(`PASS ${count} mounted production browser scenarios`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
