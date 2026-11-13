import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const esbuild = require(process.env.ESBUILD_MODULE || "esbuild");
const result = await esbuild.build({
  entryPoints: [path.join(directory, "mounted-fixture.tsx")],
  bundle: true,
  write: false,
  outdir: path.join(directory, "dist"),
  platform: "browser",
  format: "iife",
  jsx: "automatic",
});
const js = result.outputFiles.find((file) => file.path.endsWith(".js")).text;
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
const origin = `http://127.0.0.1:${server.address().port}`;
async function test(name, viewport, query, run) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${origin}/?${query}`);
  try {
    await run(page);
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}
async function load(page) {
  await page.getByRole("button", { name: "Load verified metrics" }).click();
  await page.getByText("Verified snapshot").waitFor();
}
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    await test(`overview ${viewport.width}px`, viewport, "", async (page) => {
      await load(page);
      await page.getByRole("heading", { name: "Overview and trends" }).waitFor();
      await page.getByText(/Instagram analytics unavailable/i).waitFor();
    });
    await test(`videos/detail ${viewport.width}px`, viewport, "", async (page) => {
      await page.getByRole("button", { name: "Videos" }).click();
      await page.getByText(/#1 .*video-top/).waitFor();
      await page.getByRole("button", { name: /#1/ }).click();
      await page.getByRole("region", { name: "Video detail" }).waitFor();
    });
    await test(`comparisons ${viewport.width}px`, viewport, "mode=insufficient", async (page) => {
      await load(page);
      await page.getByRole("button", { name: "Comparisons" }).click();
      await page.getByText("Genre comparisons are not supported.").waitFor();
      await page.getByText(/Insufficient sample size/).waitFor();
    });
    await test(`recommendations ${viewport.width}px`, viewport, "", async (page) => {
      await load(page);
      await page.getByRole("button", { name: "Recommendations" }).click();
      await page.getByText(/AI status: NOT_CONFIGURED/).waitFor();
      await page.getByText(/Evidence snapshots:/).waitFor();
    });
  }
  await test("viewer controls hidden", { width: 390, height: 844 }, "role=VIEWER", async (page) => {
    assert.equal(await page.getByRole("button", { name: "Collect data" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Generate report" }).count(), 0);
  });
  await test("editor collects and runs", { width: 1440, height: 1000 }, "", async (page) => {
    await page.getByRole("button", { name: "Collect data" }).click();
    await page.getByText(/Verified snapshot/).waitFor();
    const calls = await page.evaluate(() => window.m28Fixture.calls);
    assert(calls.some((call) => call.method === "POST" && call.path.endsWith("/run")));
  });
  for (const mode of ["missing", "partial", "insufficient", "unavailable"])
    await test(`state ${mode}`, { width: 390, height: 844 }, `mode=${mode}`, async (page) => {
      await page.getByRole("button", { name: "Load verified metrics" }).click();
      if (mode === "insufficient") await page.getByRole("button", { name: "Comparisons" }).click();
      await page
        .locator("body")
        .getByText(/No verified|PARTIAL|Insufficient|UNAVAILABLE/)
        .first()
        .waitFor();
    });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
