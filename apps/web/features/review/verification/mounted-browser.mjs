import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  outdir: path.join(root, "work/m26-browser"),
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
const videoPath = path.join(root, "work/m26-preview.mp4");
fs.mkdirSync(path.dirname(videoPath), { recursive: true });
execFileSync(
  process.env.FFMPEG_PATH || "/usr/bin/ffmpeg",
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=108x192:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    videoPath,
  ],
  { stdio: "ignore" },
);
const video = fs.readFileSync(videoPath);
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/brand/")) {
    response.setHeader("Content-Type", "image/svg+xml");
    response.end(
      fs.readFileSync(path.join(root, "apps/web/public/brand", path.basename(request.url))),
    );
    return;
  }
  if (request.url?.includes("/content")) {
    const valid = request.headers.referer?.includes("mode=valid-media");
    response.setHeader("Content-Type", "video/mp4");
    response.statusCode = valid ? 200 : 410;
    response.end(valid ? video : "expired");
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
  await test(
    "bounded pending queue and navigation",
    async (page) => {
      await page.getByRole("heading", { name: "Review queue" }).waitFor();
      await page.getByText(/Up to 50 current pending/).waitFor();
      assert(
        (
          await page.getByRole("link", { name: /Inspect evidence/ }).getAttribute("href")
        ).startsWith("/review/runs/"),
      );
      assert.equal(
        await page
          .getByRole("link", { name: "Review queue", exact: true })
          .first()
          .getAttribute("href"),
        "/review",
      );
    },
    "mode=queue",
  );
  for (const mode of ["queue", "queue-blocked", "queue-no-scorecard"])
    await test(
      `${mode} describes persisted AI availability accurately`,
      async (page) => {
        await page.getByText(/Inspect evidence/).waitFor();
        const card = page.getByRole("link", { name: /Inspect evidence/ });
        assert(
          (await card.innerText()).includes(
            mode === "queue" ? "AI evaluation unavailable" : "No AI scorecard recorded",
          ),
        );
        if (mode !== "queue")
          assert(!(await card.innerText()).includes("AI evaluation unavailable"));
      },
      `mode=${mode}`,
    );
  await test(
    "workspace switch discards the prior tenant's late queue response",
    async (page) => {
      await page.getByText(/Fetching persisted review state/).waitFor();
      await page.getByRole("button", { name: "Switch fixture workspace" }).click();
      await page.getByText(/No pending reviews/).waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.getByText(/Inspect evidence/).count(), 0);
      assert(
        (await page.evaluate(() => window.m26Fixture.calls)).some((c) =>
          c.path.includes("second-workspace"),
        ),
      );
    },
    "mode=isolation",
  );
  await test(
    "empty workspace queue",
    async (page) => {
      await page.getByText(/No pending reviews/).waitFor();
    },
    "mode=empty",
  );
  await test(
    "failed queue read retries",
    async (page) => {
      await page.getByRole("button", { name: "Retry read" }).click();
      await page.getByText(/Inspect evidence/).waitFor();
    },
    "mode=error",
  );
  await test(
    "unavailable AI, evidence and Owner approval",
    async (page) => {
      await page.getByText(/No valid persisted AI scorecard/).waitFor();
      await page.getByLabel("Decision", { exact: true }).selectOption("APPROVE");
      assert.equal(await page.getByRole("button", { name: "Record decision" }).isDisabled(), true);
      await page.getByLabel("Decision reason").fill("I inspected the evidence");
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByText("Reviewer ID: persisted-human-id").waitFor();
      await page.getByText("Quality state eligible to proceed", { exact: true }).waitFor();
    },
    "role=OWNER",
  );
  await test(
    "Viewer remains read-only",
    async (page) => {
      await page.getByText(/Viewer access is read-only/).waitFor();
      assert.equal(await page.getByLabel("Decision", { exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Record decision" }).isDisabled(), true);
    },
    "role=VIEWER",
  );
  await test(
    "failed gates block approval and require route override",
    async (page) => {
      await page.getByRole("heading", { name: "Human review" }).waitFor();
      assert.equal(await page.locator('option[value="APPROVE"]').isDisabled(), true);
      await page.getByLabel("Decision", { exact: true }).selectOption("REQUEST_CHANGES");
      await page.getByLabel("Regeneration target").selectOption("SCRIPT");
      await page.getByLabel("Override reason").waitFor();
      await page.getByLabel("Decision reason").fill("Improve the opening timing");
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByText(/Enter an override reason/).waitFor();
      await page.getByLabel("Override reason").fill("Fix pacing in the source script");
      page.once("dialog", (d) => d.accept());
      await page.getByRole("button", { name: "Record decision" }).click();
      await page.getByText("Reviewer ID: persisted-human-id").waitFor();
      assert.equal(
        (await page.evaluate(() => window.m26Fixture.calls.filter((c) => c.method === "POST")))
          .length,
        1,
      );
    },
    "mode=blocked",
  );
  await test(
    "missing evidence is unavailable and blocks approval",
    async (page) => {
      await page.getByText("Evidence unavailable", { exact: true }).first().waitFor();
      assert.equal(await page.locator('option[value="APPROVE"]').isDisabled(), true);
      await page.getByText("Blocked from proceeding", { exact: true }).waitFor();
    },
    "mode=missing",
  );
  await test(
    "persisted AI criteria and provenance",
    async (page) => {
      await page.getByText(/fixture-model-v1/).waitFor();
      await page.getByRole("heading", { name: "factuality · 84/100" }).waitFor();
      assert.equal(await page.getByText(/No valid persisted/).count(), 0);
    },
    "mode=ai",
  );
  await test(
    "automatic approval is separate from human history",
    async (page) => {
      await page.getByText("Automatic approval", { exact: true }).waitFor();
      await page.getByText(/No human decisions recorded/).waitFor();
    },
    "mode=auto",
  );
  await test(
    "history preserves actor, override, attempts and safe workflow links",
    async (page) => {
      await page.getByText("Reviewer ID: persisted-reviewer-id").waitFor();
      await page.getByText("Override reason: Rework pacing").waitFor();
      assert(
        (
          await page.getByRole("link", { name: "Open scene workflow" }).getAttribute("href")
        ).startsWith("/production/jobs/"),
      );
      assert(
        (
          await page.getByRole("link", { name: "Open script workflow" }).getAttribute("href")
        ).startsWith("/planning/scripts/"),
      );
      assert.equal(
        await page.getByRole("link", { name: "Open render workflow" }).getAttribute("href"),
        "/production/renders/50000000-0000-4000-8000-000000000005",
      );
      await page.getByText(/This successful render cannot be retried/).waitFor();
      await page
        .getByText(/Creating a new render from a review request is not supported/)
        .waitFor();
      assert.equal(
        (await page.evaluate(() => window.m26Fixture.calls.filter((c) => c.method === "POST")))
          .length,
        0,
      );
    },
    "mode=history",
  );
  for (const mode of ["ambiguous", "conflict"])
    await test(
      `${mode} response reconciles with GET only`,
      async (page) => {
        await page.getByLabel("Decision", { exact: true }).selectOption("REJECT");
        await page.getByLabel("Decision reason").fill("Review requires changes");
        page.once("dialog", (d) => d.accept());
        await page.getByRole("button", { name: "Record decision" }).click();
        await page.getByRole("button", { name: "Fetch persisted review" }).click();
        await page
          .getByText(`Fetched status: ${mode === "ambiguous" ? "rejected" : "superseded"}`)
          .waitFor();
        await page.getByRole("button", { name: "I have compared the persisted state" }).click();
        await page.getByText("This review is closed. Decisions cannot be repeated.").waitFor();
        assert.equal(
          (await page.evaluate(() => window.m26Fixture.calls.filter((c) => c.method === "POST")))
            .length,
          1,
        );
      },
      `mode=${mode}`,
    );
  await test(
    "authorized video preview loads valid local media",
    async (page) => {
      await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
      assert((await page.locator("video").getAttribute("src")).startsWith("/api/v1/workspaces/"));
      assert.equal(await page.getByText(/could not be loaded/).count(), 0);
    },
    "mode=valid-media",
  );
  await test("scene change request requires pinned scene and dispatches no production work", async (page) => {
    await page.getByLabel("Decision", { exact: true }).selectOption("REQUEST_CHANGES");
    await page.getByLabel("Decision reason").fill("Improve this scene");
    await page.getByLabel("Regeneration target").selectOption("SCENE");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Record decision" }).click();
    await page.getByText(/Select an existing scene/).waitFor();
    await page.getByLabel("Existing pinned scene").selectOption("scene-one");
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Record decision" }).click();
    await page.getByRole("link", { name: "Open scene workflow" }).waitFor();
    const posts = await page.evaluate(() =>
      window.m26Fixture.calls.filter((c) => c.method === "POST"),
    );
    assert.equal(posts.length, 1);
    assert(posts[0].path.endsWith("/decision"));
  });
  for (const width of [390, 1440])
    await test(
      `${width}px responsive layout, keyboard and media failure`,
      async (page) => {
        await page.getByRole("heading", { name: "Human review" }).waitFor();
        await page.getByText(/Quality review video could not be loaded/).waitFor();
        assert((await page.locator("video").count()) === 0);
        assert.equal(
          await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
          true,
        );
        await page.getByLabel("Decision", { exact: true }).focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await page.getByLabel("Decision reason").evaluate((el) => el === document.activeElement),
          true,
        );
        await page.screenshot({
          path: path.join(root, `work/m26-review-${width}.png`),
          fullPage: true,
        });
      },
      "",
      { width, height: 1000 },
    );
  console.log(`PASS ${count} mounted review browser scenarios`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
