import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const esbuild = require(process.env.ESBUILD_MODULE || "esbuild");
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../../../../..");
const bundle = await esbuild.build({
  entryPoints: [path.join(dir, "mounted-fixture.tsx")],
  bundle: true,
  write: false,
  outdir: "/tmp/operations-browser",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
const global = fs
  .readFileSync(path.join(root, "apps/web/app/globals.css"), "utf8")
  .replace(/@import[^;]+;/g, "");
const tokens = fs.readFileSync(path.join(root, "apps/web/styles/design-tokens.css"), "utf8");
const server = http.createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(js);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<style>${tokens}\n${global}\n${css}</style><div id="root"></div><script src="/bundle.js"></script>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const width of [390, 1440])
    for (const role of ["OWNER", "EDITOR", "VIEWER"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${server.address().port}/?role=${role}`);
      await page.getByRole("heading", { name: "Workflow control room" }).waitFor();
      const editor = role !== "VIEWER";
      assert.equal(
        await page.getByRole("button", { name: "cancel", exact: true }).count(),
        Number(editor),
      );
      assert.equal(await page.getByRole("button", { name: "Mark all read" }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Save preferences" }).count(), 1);
      assert.equal(
        await page.getByRole("button", { name: "Save budget" }).count(),
        Number(role === "OWNER"),
      );
      assert.equal(await page.locator('input[type="checkbox"]:disabled').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (role === "VIEWER") {
        await page.getByRole("button", { name: "Save preferences" }).click();
        await page.waitForFunction(() => window.calls.some((call) => call.startsWith("PUT ")));
        const writes = await page.evaluate(() =>
          window.calls.filter((call) => !call.startsWith("GET ")),
        );
        assert.deepEqual(writes, ["PUT /api/v1/workspaces/workspace/notifications/preferences"]);
      }
      await page.close();
      console.log(`PASS ${role} ${width}px`);
    }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
