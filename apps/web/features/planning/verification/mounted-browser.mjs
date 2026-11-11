/* Browser tooling is supplied outside the repository; no new application dependencies. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const esbuild = require(process.env.ESBUILD_MODULE || "esbuild");
const root = path.resolve(directory, "../../../../..");
const output = await esbuild.build({
  entryPoints: [path.join(directory, "mounted-fixture.tsx")],
  bundle: true,
  write: false,
  outdir: "/tmp/m24-browser",
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: {
    "next/link": path.join(directory, "next-link.tsx"),
    "next/navigation": path.join(directory, "next-link.tsx"),
  },
});
const js = output.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = output.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const global = fs
  .readFileSync(path.join(root, "apps/web/app/globals.css"), "utf8")
  .replace(/@import[^;]+;/g, "");
const tokens = fs.readFileSync(path.join(root, "apps/web/styles/design-tokens.css"), "utf8");
const server = http.createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/bundle.js"
      ? "application/javascript"
      : req.url === "/style.css"
        ? "text/css"
        : "text/html",
  );
  res.end(
    req.url === "/bundle.js"
      ? js
      : req.url === "/style.css"
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
const errors = [];
async function test(name, run, query = "", viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
    await page.getByRole("button", { name: "Test workspace navigation" }).waitFor();
    await run(page);
    count++;
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}
try {
  await test("targeted edits persist with the observed revision and preserve unrelated scenes", async (p) => {
    await p.getByLabel("Scene dialogue", { exact: true }).fill("Targeted revision");
    const cues = p.getByLabel("Audio cues — one per line", { exact: true });
    await cues.fill("Birdsong");
    await cues.press("End");
    await cues.press("Enter");
    await cues.pressSequentially("Soft piano");
    assert.equal(await cues.inputValue(), "Birdsong\nSoft piano");
    await p.getByRole("button", { name: "Save script revision", exact: true }).click();
    await p.getByText("Revision 2 saved by the server.", { exact: true }).waitFor();
    const posted = (await p.evaluate(() => window.m24Fixture.calls)).find(
      (c) => c.path.endsWith("/revisions") && c.method === "POST",
    ).body;
    assert.equal(posted.expectedRevision, 1);
    assert.equal(posted.document.scenes[1].dialogue, "Then continue");
    await p.getByRole("button", { name: "Scene 2 · 10s", exact: true }).click();
    assert.equal(
      await p.getByLabel("Scene dialogue", { exact: true }).inputValue(),
      "Then continue",
    );
    await p.getByRole("button", { name: "Inspect revision 1", exact: true }).click();
    assert.equal(await p.getByLabel("Scene dialogue", { exact: true }).isDisabled(), true);
  });
  await test("reordering, duration validation and keyboard scene selection", async (p) => {
    await p.getByRole("button", { name: "Move scene later", exact: true }).click();
    assert.equal(await p.getByLabel("Scene start (seconds)").inputValue(), "10");
    await p.getByLabel("Scene duration (seconds)").fill("30");
    assert.equal(
      await p.getByRole("button", { name: "Save script revision", exact: true }).isDisabled(),
      true,
    );
    await p.getByRole("button", { name: "Use scene total as target" }).click();
    assert.equal(
      await p.getByRole("button", { name: "Save script revision", exact: true }).isEnabled(),
      true,
    );
    const scene = p.getByRole("button", { name: "Scene 1 · 10s", exact: true });
    await scene.focus();
    await p.keyboard.press("Enter");
    assert.equal(
      await p.getByLabel("Scene dialogue", { exact: true }).inputValue(),
      "Then continue",
    );
  });
  await test("published character versions only; unsupported assets remain disabled", async (p) => {
    await p.getByLabel("Scene character", { exact: true }).selectOption("char-one");
    await p.getByLabel("Published scene character version").selectOption("version-one");
    assert.equal(await p.getByRole("option", { name: "Version 2", exact: true }).count(), 0);
    await p.getByRole("button", { name: "Assign published character" }).click();
    await p.getByRole("button", { name: "Remove character reference", exact: true }).waitFor();
    await p.getByRole("button", { name: "Save script revision", exact: true }).click();
    await p.getByText("Revision 2 saved by the server.", { exact: true }).waitFor();
    assert.equal(await p.getByRole("button", { name: /Assign scene asset/ }).isDisabled(), true);
  });
  await test(
    "viewer permissions disable idea and script mutations",
    async (p) => {
      assert.equal(await p.getByLabel("Scene dialogue", { exact: true }).isDisabled(), true);
      assert.equal(
        await p.getByRole("button", { name: "Save script revision", exact: true }).isDisabled(),
        true,
      );
    },
    "role=VIEWER",
  );
  await test("unsaved workspace navigation can be cancelled", async (p) => {
    await p.getByLabel("Scene dialogue", { exact: true }).fill("Keep my work");
    let dialogs = 0;
    p.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await p.getByRole("button", { name: "Test workspace navigation" }).click();
    assert.equal(dialogs, 1);
    assert.equal(
      await p.getByLabel("Scene dialogue", { exact: true }).inputValue(),
      "Keep my work",
    );
  });
  await test("stale revision keeps draft and offers explicit comparison", async (p) => {
    await p.getByLabel("Scene dialogue", { exact: true }).fill("Local work");
    await p.evaluate(() => window.m24Fixture.remote());
    await p.getByText("Compare server and working draft", { exact: true }).waitFor();
    assert.equal(await p.getByLabel("Scene dialogue", { exact: true }).inputValue(), "Local work");
    assert.equal(
      await p.getByRole("button", { name: "Save script revision", exact: true }).isDisabled(),
      true,
    );
  });
  await test(
    "lost acknowledgement preserves the draft and requires successful affected-resource comparison",
    async (p) => {
      await p.getByLabel("Title", { exact: true }).fill("Committed despite response loss");
      await p.evaluate(() => window.m24Fixture.loseCommitResponse());
      await p.getByRole("button", { name: "Save brief", exact: true }).click();
      await p.getByText("Response lost after commit", { exact: true }).waitFor();
      const confirm = p.getByRole("button", {
        name: "I have compared the fetched saved state",
        exact: true,
      });
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(
        await p.getByRole("button", { name: "Save brief", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        (await p.evaluate(() => window.m24Fixture.calls)).filter((c) => c.method === "PATCH")
          .length,
        1,
      );
      await p.getByRole("button", { name: "Fetch affected saved resource", exact: true }).click();
      await p.getByText("Fetched saved state: Idea idea-one", { exact: true }).waitFor();
      assert(
        (await p.locator("details pre").textContent()).includes("Committed despite response loss"),
      );
      assert(
        await p.evaluate(() => sessionStorage.getItem("reelforge.planning.pending:workspace-one")),
      );
      await confirm.click();
      assert.equal(
        await p.evaluate(() => sessionStorage.getItem("reelforge.planning.pending:workspace-one")),
        null,
      );
    },
    "mode=idea",
  );
  await test(
    "reconciliation cannot clear before a read, after a failed read, or during a deferred read",
    async (p) => {
      const confirm = p.getByRole("button", {
        name: "I have compared the fetched saved state",
        exact: true,
      });
      assert.equal(await confirm.isDisabled(), true);
      await p.evaluate(() => window.m24Fixture.failReads());
      await p.getByRole("button", { name: "Fetch affected saved resource", exact: true }).click();
      await p.getByText(/Reconciliation failed: Read unavailable/).waitFor();
      assert.equal(await confirm.isDisabled(), true);
      assert(
        await p.evaluate(() => sessionStorage.getItem("reelforge.planning.pending:workspace-one")),
      );
      await p.evaluate(() => {
        window.m24Fixture.failReads(false);
        window.m24Fixture.pauseReads();
      });
      await p.getByRole("button", { name: "Fetch affected saved resource", exact: true }).click();
      assert.equal(await confirm.isDisabled(), true);
      await p.evaluate(() => window.m24Fixture.releaseReads());
      await p.getByText("Fetched saved state: Idea idea-one", { exact: true }).waitFor();
      assert.equal(await confirm.isEnabled(), true);
      await confirm.click();
      assert.equal(
        await p.evaluate(() => sessionStorage.getItem("reelforge.planning.pending:workspace-one")),
        null,
      );
    },
    "mode=recovery",
  );
  await test("sequential storyboard reports gaps and overlaps until explicit reflow", async (p) => {
    await p.getByRole("button", { name: "Scene 2 · 10s", exact: true }).click();
    for (const start of ["5", "15"]) {
      await p.getByLabel("Scene start (seconds)").fill(start);
      await p
        .getByText(/This storyboard uses sequential scenes without gaps or overlaps/)
        .waitFor();
      assert.equal(await p.getByLabel("Scene start (seconds)").inputValue(), start);
      await p.getByRole("button", { name: "Reflow scene starts", exact: true }).click();
      assert.equal(await p.getByLabel("Scene start (seconds)").inputValue(), "10");
    }
  });
  await test(
    "idea brief edit persists and refreshed props never roll back save",
    async (p) => {
      await p.getByLabel("Title", { exact: true }).fill("Edited brief");
      const references = p.getByLabel("References — one per line", { exact: true });
      await references.fill("https://example.com/one");
      await references.press("End");
      await references.press("Enter");
      await references.pressSequentially("https://example.com/two");
      assert.equal(
        await references.inputValue(),
        "https://example.com/one\nhttps://example.com/two",
      );
      await p.getByRole("button", { name: "Save brief", exact: true }).click();
      await p.getByText("Idea saved by the server.", { exact: true }).waitFor();
      assert.equal(await p.getByLabel("Title", { exact: true }).inputValue(), "Edited brief");
    },
    "mode=idea",
  );
  await test(
    "failed route refresh preserves the open script draft",
    async (p) => {
      await p.getByLabel("Scene dialogue", { exact: true }).fill("Recover this draft");
      await p.evaluate(() => window.m24Fixture.failReads());
      await p.evaluate(() => window.m24Fixture.remote());
      await p.getByText("Planning data unavailable", { exact: true }).first().waitFor();
      assert.equal(
        await p.getByLabel("Scene dialogue", { exact: true }).inputValue(),
        "Recover this draft",
      );
    },
    "mode=route",
  );
  await test(
    "idea discovery supports local search and real status/archive filter requests",
    async (p) => {
      await p.getByRole("heading", { name: "A creative habit", exact: true }).waitFor();
      await p.getByLabel("Search ideas", { exact: true }).fill("no-match");
      assert.equal(
        await p.getByRole("heading", { name: "A creative habit", exact: true }).count(),
        0,
      );
      await p.getByLabel("Search ideas", { exact: true }).fill("creative");
      await p.getByRole("heading", { name: "A creative habit", exact: true }).waitFor();
      await p.getByLabel("Idea status", { exact: true }).selectOption("BACKLOG");
      await p.getByLabel("Archive visibility", { exact: true }).selectOption("all");
      await p.waitForFunction(() =>
        window.m24Fixture.calls.some(
          (c) => c.path.includes("includeArchived=true") && c.path.includes("status=BACKLOG"),
        ),
      );
      await p.getByRole("tab", { name: "Scripts & storyboard", exact: true }).click();
      await p.getByRole("heading", { name: "A small creative habit", exact: true }).waitFor();
    },
    "mode=library",
  );
  await test("explicit script approval refreshes immutable state and approved export", async (p) => {
    p.once("dialog", (d) => d.accept());
    await p.getByRole("button", { name: "Approve saved script", exact: true }).click();
    await p.getByText("Script approved by the server.", { exact: true }).waitFor();
    await p.getByText("Inspect approved export revision 1", { exact: true }).waitFor();
    assert.equal(await p.getByLabel("Scene dialogue", { exact: true }).isDisabled(), true);
    const call = (await p.evaluate(() => window.m24Fixture.calls)).find(
      (c) => c.path.endsWith("/approve") && c.method === "POST",
    );
    assert.deepEqual(call.body, { expectedRevision: 1 });
  });
  await test(
    "idea status conflict requires an explicit refreshed comparison before another action",
    async (p) => {
      await p.getByRole("button", { name: "Approve idea", exact: true }).waitFor();
      await p.evaluate(() => window.m24Fixture.remoteIdea());
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Approve idea", exact: true }).click();
      await p.getByText("Compare idea before another action", { exact: true }).waitFor();
      const useLatest = p.getByRole("button", {
        name: "Use refreshed brief for next action",
        exact: true,
      });
      await useLatest.click();
      const calls = await p.evaluate(() =>
        window.m24Fixture.calls.filter((c) => c.path.endsWith("/status")),
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.expectedStatus, "DRAFT");
      p.once("dialog", (d) => d.accept());
      await p.getByRole("button", { name: "Approve idea", exact: true }).click();
      await p.getByText("Idea action saved by the server.", { exact: true }).waitFor();
      const next = await p.evaluate(() =>
        window.m24Fixture.calls.filter((c) => c.path.endsWith("/status")),
      );
      assert.equal(next[1].body.expectedStatus, "BACKLOG");
      assert.equal(next[1].body.expectedUpdatedAt, "2026-11-12T02:00:00.000Z");
    },
    "mode=idea-route",
  );
  for (const width of [390, 768, 1440])
    await test(
      `responsive storyboard ${width}px`,
      async (p) => {
        await p.getByLabel("Scene dialogue", { exact: true }).waitFor();
        assert(
          await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "page must not overflow horizontally",
        );
        await p.screenshot({ path: `/tmp/m24-storyboard-${width}.png`, fullPage: true });
      },
      "",
      { width, height: 1000 },
    );
  assert.deepEqual(errors, []);
  console.log(`${count} mounted browser tests passed; no page errors.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
