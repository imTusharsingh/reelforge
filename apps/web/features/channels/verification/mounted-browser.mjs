/* Test-only runner: browser/bundler are supplied outside the repository; no app dependencies change. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadModule = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../../../../..");
const { chromium } = loadModule(process.env.PLAYWRIGHT_MODULE || "playwright");
const esbuild = loadModule(process.env.ESBUILD_MODULE || "esbuild");
(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "mounted-fixture.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const styles = fs
    .readFileSync(path.join(root, "apps/web/app/globals.css"), "utf8")
    .replace(/@import[^;]+;/g, "");
  const server = http.createServer((req, res) => {
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(result.outputFiles[0].text);
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(
        fs.readFileSync(path.join(root, "apps/web/styles/design-tokens.css"), "utf8") +
          "\n" +
          styles,
      );
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>',
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  let passed = 0;
  const errors = [];
  async function test(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (options.fallback)
      await context.addInitScript(() =>
        Object.defineProperty(window, "navigation", { value: undefined }),
      );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(10000);
    try {
      await page.goto(base);
      await page.getByLabel("Test channel name", { exact: true }).waitFor();
      await run(page);
      passed++;
      console.log("PASS " + name);
    } finally {
      await context.close();
    }
  }
  try {
    await test("mounted editor saves the edited payload and refreshes resources", async (p) => {
      await p.getByLabel("Test channel name", { exact: true }).fill("Updated studio");
      await p.getByRole("button", { name: "Save test channel", exact: true }).click();
      await p.getByText("Saved by the server.", { exact: true }).waitFor();
      const calls = await p.evaluate(() => window.m23Fixture.calls);
      assert(calls.some((c) => c.method === "PATCH" && c.body.name === "Updated studio"));
      assert(calls.filter((c) => c.method === "GET" && c.path.startsWith("config")).length > 2);
    });
    await test("pristine editor rebases fetched values; dirty editor preserves edits until explicit reload", async (p) => {
      await p.evaluate(() => window.m23Fixture.setInitial("Server revision"));
      await p.waitForFunction(() => document.querySelector("input")?.value === "Server revision");
      await p.getByLabel("Test channel name", { exact: true }).fill("My draft");
      await p.evaluate(() => window.m23Fixture.setInitial("Newer server revision"));
      await p.getByText("Saved data changed", { exact: true }).waitFor();
      assert.equal(
        await p.getByLabel("Test channel name", { exact: true }).inputValue(),
        "My draft",
      );
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Load latest saved values", exact: true }).click();
      assert.equal(
        await p.getByLabel("Test channel name", { exact: true }).inputValue(),
        "Newer server revision",
      );
    });
    await test("structured character controls preserve advanced settings", async (p) => {
      await p.getByLabel("Personality traits", { exact: true }).fill("curious\npatient");
      const raw = await p.getByLabel("Personality JSON", { exact: true }).inputValue();
      assert.deepEqual(JSON.parse(raw), { traits: ["curious", "patient"], energy: "warm" });
    });
    await test("series and published-version pickers use scoped API results, not text IDs", async (p) => {
      await p
        .getByLabel("Assignment series", { exact: true })
        .selectOption({ label: "Daily science" });
      await p.getByRole("button", { name: "Assign to series", exact: true }).click();
      await p
        .getByLabel("Published character version", { exact: true })
        .selectOption({ label: "Version 1 — Nova" });
      assert.equal(
        await p
          .getByLabel("Published character version", { exact: true })
          .locator("option")
          .count(),
        2,
      );
      await p.getByRole("button", { name: "Add member", exact: true }).click();
      const calls = await p.evaluate(() => window.m23Fixture.calls);
      assert(calls.some((c) => c.path.endsWith("/assignments") && c.body.seriesId));
      assert(calls.some((c) => c.path.endsWith("/members") && c.body.characterVersionId));
    });
    await test("snapshot and prompt activation refresh server-confirmed active state", async (p) => {
      const ids = await p.evaluate(() => window.m23Fixture.ids);
      await p.getByLabel("Channel snapshot", { exact: true }).selectOption(ids.secondSnapshot);
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Select snapshot", exact: true }).click();
      await p.waitForFunction(
        (id) => document.querySelector('[data-testid="active-channel"]')?.textContent === id,
        ids.secondSnapshot,
      );
      await p
        .getByLabel("Workspace snapshot to activate", { exact: true })
        .selectOption(ids.secondSnapshot);
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Activate snapshot", exact: true }).click();
      await p.getByText("Active workspace snapshot: version 2", { exact: true }).waitFor();
      await p.getByLabel("Prompt template", { exact: true }).selectOption(ids.template);
      await p.getByLabel("Prompt version", { exact: true }).selectOption(ids.secondVersion);
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Activate prompt version", exact: true }).click();
      await p.getByText("Active prompt version: " + ids.secondVersion, { exact: true }).waitFor();
      await p.getByLabel("Prompt version", { exact: true }).selectOption(ids.version);
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Roll back prompt", exact: true }).click();
      await p.getByText("Active prompt version: " + ids.version, { exact: true }).waitFor();
    });
    for (const width of [1440, 390])
      await test(`cancel/confirm link and keyboard session/workspace intents at ${width}px`, async (p) => {
        await p.setViewportSize({ width, height: 844 });
        await p.getByLabel("Test channel name", { exact: true }).fill("Draft");
        p.once("dialog", (d) => d.dismiss());
        await p.getByRole("link", { name: "Navigate away" }).click();
        assert.equal(new URL(p.url()).pathname, "/");
        await p.getByRole("button", { name: "Choose another workspace" }).focus();
        p.once("dialog", (d) => d.dismiss());
        await p.keyboard.press("Enter");
        assert.equal(
          await p.getByLabel("Test channel name", { exact: true }).inputValue(),
          "Draft",
        );
        await p.getByRole("button", { name: "End session" }).focus();
        p.once("dialog", (d) => d.dismiss());
        await p.keyboard.press("Enter");
        assert(await p.getByRole("button", { name: "Save test channel" }).isEnabled());
        p.once("dialog", (d) => d.accept());
        await p.getByRole("link", { name: "Navigate away" }).click();
        await p.waitForURL("**/destination");
        assert.equal(
          await p.getByLabel("Test channel name", { exact: true }).inputValue(),
          "Science studio",
        );
      });
    await test("programmatic navigation can be cancelled before routing", async (p) => {
      await p.getByLabel("Test channel name", { exact: true }).fill("Draft");
      p.once("dialog", (d) => d.dismiss());
      assert.equal(await p.evaluate(() => window.m23Fixture.programmatic()), false);
      assert.equal(new URL(p.url()).pathname, "/");
      p.once("dialog", (d) => d.accept());
      assert.equal(await p.evaluate(() => window.m23Fixture.programmatic()), true);
      await p.waitForURL("**/programmatic");
    });
    for (const mode of ["desktop", "mobile", "fallback"])
      await test(
        `browser Back/Forward cancel and confirm (${mode})`,
        async (p) => {
          if (mode === "mobile") await p.setViewportSize({ width: 390, height: 844 });
          await p.evaluate(() => {
            history.pushState({}, "", "/first");
            history.pushState({}, "", "/second");
          });
          async function traverse(direction, accept, expected) {
            const dialog = p.waitForEvent("dialog");
            await p.evaluate(
              (direction) => (direction === "back" ? history.back() : history.forward()),
              direction,
            );
            const prompt = await dialog;
            if (accept) await prompt.accept();
            else await prompt.dismiss();
            await p.waitForFunction((expected) => location.pathname === expected, expected);
          }
          await p.getByLabel("Test channel name", { exact: true }).fill("Back draft");
          await traverse("back", false, "/second");
          assert.equal(
            await p.getByLabel("Test channel name", { exact: true }).inputValue(),
            "Back draft",
          );
          await traverse("back", true, "/first");
          await p.getByLabel("Test channel name", { exact: true }).fill("Forward draft");
          await traverse("forward", false, "/first");
          assert.equal(
            await p.getByLabel("Test channel name", { exact: true }).inputValue(),
            "Forward draft",
          );
          await traverse("forward", true, "/second");
        },
        { fallback: mode === "fallback" },
      );
    await test("context switch aborts old saves and uncertain outcomes trigger reconciliation warning", async (p) => {
      await p.evaluate(() => window.m23Fixture.defer());
      await p.getByLabel("Test channel name", { exact: true }).fill("Possibly committed");
      await p.getByRole("button", { name: "Save test channel" }).click();
      await p.waitForFunction(() => window.m23Fixture.calls.some((c) => c.method === "PATCH"));
      await p.evaluate(() => {
        window.m23Fixture.switchContext();
        window.m23Fixture.release();
      });
      await p.waitForFunction(
        () =>
          document.querySelector('[data-testid="workspace"]')?.textContent ===
          window.m23Fixture.ids.otherWorkspace,
      );
      await p.evaluate(() => window.m23Fixture.switchContext());
      await p.getByText("Check the outcome of an earlier save", { exact: true }).waitFor();
    });
    for (const width of [1440, 390])
      await test(`confirmed keyboard workspace and logout intents at ${width}px`, async (p) => {
        await p.setViewportSize({ width, height: 844 });
        await p.getByLabel("Test channel name", { exact: true }).fill("Discard this draft");
        await p.getByRole("button", { name: "Choose another workspace" }).focus();
        p.once("dialog", (d) => d.accept());
        await p.keyboard.press("Enter");
        await p.waitForFunction(
          () =>
            document.querySelector('[data-testid="workspace"]')?.textContent ===
            window.m23Fixture.ids.otherWorkspace,
        );
        await p.getByLabel("Test channel name", { exact: true }).fill("Logout draft");
        p.once("dialog", (d) => d.accept());
        await p.getByRole("button", { name: "End session" }).click();
        await p.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
        assert(await p.getByRole("button", { name: "Save test channel" }).isDisabled());
      });
    await test("EDITOR seam can save and a pending role downgrade discards stale success", async (p) => {
      await p.evaluate(() => window.m23Fixture.setRole("EDITOR"));
      await p.getByLabel("Test channel name", { exact: true }).fill("Editor draft");
      await p.getByRole("button", { name: "Save test channel" }).click();
      await p.getByText("Saved by the server.", { exact: true }).waitFor();
      await p.evaluate(() => window.m23Fixture.defer());
      await p.getByLabel("Test channel name", { exact: true }).fill("Late editor draft");
      await p.getByRole("button", { name: "Save test channel" }).click();
      await p.waitForFunction(
        () => window.m23Fixture.calls.filter((c) => c.method === "PATCH").length === 2,
      );
      await p.evaluate(() => {
        window.m23Fixture.setRole("VIEWER");
        window.m23Fixture.release();
      });
      await p.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
      assert.equal(await p.getByText("Saved by the server.", { exact: true }).count(), 0);
    });
    await test("UNKNOWN and VIEWER mounted forms remain disabled", async (p) => {
      for (const role of ["UNKNOWN", "VIEWER"]) {
        await p.evaluate((role) => window.m23Fixture.setRole(role), role);
        await p.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
        assert(await p.getByRole("button", { name: "Save test channel" }).isDisabled());
      }
      assert(!(await p.evaluate(() => window.m23Fixture.calls)).some((c) => c.method === "PATCH"));
    });
    assert.deepEqual(errors, []);
    console.log(`${passed} mounted browser checks passed`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
