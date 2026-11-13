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
if (process.env.M27_EVIDENCE_DIR) fs.mkdirSync(process.env.M27_EVIDENCE_DIR, { recursive: true });

const output = await esbuild.build({
  entryPoints: [path.join(directory, "mounted-fixture.tsx")],
  bundle: true,
  write: false,
  outdir: path.join(root, "work/m27-browser"),
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
const origin = `http://127.0.0.1:${server.address().port}`;
let count = 0;

async function test(name, run, query = "", viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/?${query}`);
  try {
    await run(page);
    count += 1;
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}

function calls(page) {
  return page.evaluate(() => window.m27Fixture.calls);
}

async function fillYouTube(page, reason = "No promotional content") {
  await page.getByLabel("Approved render").selectOption({ index: 1 });
  await page.getByLabel(/Fixture YouTube/).check();
  await page.getByLabel("YouTube description").fill("A fixture description");
  await page.getByLabel("Disclosure reason").fill(reason);
}

try {
  await test("publish-now composer sends one idempotent create and records delivery", async (page) => {
    await page.getByRole("heading", { name: "Publishing composer" }).waitFor();
    await fillYouTube(page);
    await page.getByLabel("Delivery").selectOption("publish-now");
    await page.getByRole("button", { name: "Continue to preflight" }).click();
    await page.getByRole("heading", { name: "Preflight" }).waitFor();
    await page.getByText("APPROVAL: passed — current approval").waitFor();
    await page.getByRole("button", { name: "Publish now" }).click();
    await page.getByRole("heading", { name: "Delivery recorded" }).waitFor();
    const posts = (await calls(page)).filter(
      (call) => call.method === "POST" && call.path.endsWith("/publishing/posts"),
    );
    assert.equal(posts.length, 1);
    assert.match(JSON.parse(posts[0].body).clientRequestId, /^[0-9a-f-]{36}$/);
  });

  await test("scheduled composer stores an explicit future time and timezone", async (page) => {
    await page.getByRole("heading", { name: "Publishing composer" }).waitFor();
    await fillYouTube(page);
    await page.getByLabel(/Schedule date and time/).fill("2026-12-01T10:00");
    await page.getByRole("button", { name: "Create scheduled post" }).click();
    await page.getByText(/Scheduled for/).waitFor();
    await page.getByRole("link", { name: "View scheduled post" }).waitFor();
    const posts = (await calls(page)).filter(
      (call) => call.method === "POST" && call.path.endsWith("/publishing/posts"),
    );
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.equal(body.scheduledAt, new Date("2026-12-01T10:00").toISOString());
    assert.equal(body.disclosure.decision, "NOT_REQUIRED");
  });

  await test(
    "blocked preflight keeps publish disabled with gate evidence",
    async (page) => {
      await page.getByRole("heading", { name: "Publishing composer" }).waitFor();
      await fillYouTube(page);
      await page.getByLabel("Delivery").selectOption("publish-now");
      await page.getByRole("button", { name: "Continue to preflight" }).click();
      await page
        .getByText("SCHEDULE: failed — Publishing schedule policy is not configured")
        .waitFor();
      assert.equal(await page.getByRole("button", { name: "Publish now" }).isDisabled(), true);
      const publishes = (await calls(page)).filter((call) => call.path.endsWith("/publish"));
      assert.equal(publishes.length, 0);
    },
    "mode=preflight-failure",
  );

  await test(
    "interrupted creation recovers by replaying the exact saved request",
    async (page) => {
      await page.getByRole("heading", { name: "Publishing composer" }).waitFor();
      await fillYouTube(page);
      await page.getByLabel("Delivery").selectOption("publish-now");
      await page.getByRole("button", { name: "Continue to preflight" }).click();
      await page.getByText("An earlier creation may have been saved").waitFor();
      await page.getByRole("button", { name: "Retry saved creation" }).click();
      await page.getByRole("heading", { name: "Preflight" }).waitFor();
      const posts = (await calls(page)).filter(
        (call) => call.method === "POST" && call.path.endsWith("/publishing/posts"),
      );
      assert.equal(posts.length, 2);
      assert.equal(
        JSON.parse(posts[0].body).clientRequestId,
        JSON.parse(posts[1].body).clientRequestId,
      );
      assert.deepEqual(JSON.parse(posts[0].body), JSON.parse(posts[1].body));
    },
    "mode=recovery",
  );

  await test(
    "retryable delivery retries once from persisted state",
    async (page) => {
      await page.getByRole("heading", { name: "Post detail" }).waitFor();
      await page.getByText("UPLOAD_INTERRUPTED: The upload was interrupted").waitFor();
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Platform post ID: fixture-platform-post").waitFor();
      const writes = (await calls(page)).filter((call) => call.method === "POST");
      assert.equal(writes.length, 1);
      assert(writes[0].path.endsWith("/retry"));
    },
    "mode=retry",
  );

  await test(
    "pending publish action stays locked until refreshed and acknowledged",
    async (page) => {
      await page.getByText("Previous action may still be pending").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "I inspected the saved state" }).isDisabled(),
        true,
      );
      await page.getByRole("button", { name: "Refresh post" }).click();
      await page.getByRole("button", { name: "I inspected the saved state" }).click();
      assert.equal(await page.getByText("Previous action may still be pending").count(), 0);
    },
    "mode=post-pending",
  );

  await test(
    "Viewer sees no composer or delivery controls",
    async (page) => {
      await page.getByText("Read-only").first().waitFor();
      assert.equal(await page.getByRole("button", { name: "Continue to preflight" }).count(), 0);
      assert.equal(await page.getByLabel("Approved render").count(), 0);
    },
    "role=VIEWER",
  );

  await test(
    "Viewer cannot retry a failed delivery",
    async (page) => {
      await page.getByRole("heading", { name: "Post detail" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Publish now" }).count(), 0);
    },
    "mode=retry&role=VIEWER",
  );

  await test(
    "OAuth failure returns a safe, actionable message",
    async (page) => {
      await page.getByText("Connection failed: access_denied. Try connecting again.").waitFor();
      await page.getByText("INSTAGRAM_NOT_VERIFIED").waitFor();
    },
    "mode=connect-error&oauthError=access_denied",
  );

  await test(
    "delivery history shows persisted platform records",
    async (page) => {
      await page.getByRole("heading", { name: "Delivery history" }).waitFor();
      await page.getByText("Platform post ID: fixture-platform-post").waitFor();
    },
    "mode=history",
  );

  for (const width of [390, 1440])
    await test(
      `calendar exposes drafts, links the composer and stays within ${width}px`,
      async (page) => {
        await page.getByRole("heading", { name: "Publishing calendar" }).waitFor();
        await page.getByText("Unscheduled drafts").waitFor();
        await page.getByRole("link", { name: /Draft created/ }).waitFor();
        assert.equal(
          await page.getByRole("link", { name: "New post" }).getAttribute("href"),
          "/publishing/new",
        );
        assert.equal(
          await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(
            process.env.M27_EVIDENCE_DIR || path.join(root, "work"),
            `m27-calendar-${width}.png`,
          ),
          fullPage: true,
        });
      },
      "mode=calendar",
      { width, height: 1000 },
    );

  for (const width of [390, 1440])
    await test(
      `${width}px composer stays within the viewport`,
      async (page) => {
        await page.getByRole("heading", { name: "Publishing composer" }).waitFor();
        await fillYouTube(page);
        await page.getByLabel("Delivery").selectOption("publish-now");
        const overflow = await page.locator("body").evaluate(() =>
          [...document.querySelectorAll("*")]
            .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
            .slice(0, 8)
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}.${String(element.className)} ${Math.round(element.getBoundingClientRect().right)}`,
            ),
        );
        if (overflow.length > 0) console.log("OVERFLOW", overflow);
        assert.equal(
          await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(
            process.env.M27_EVIDENCE_DIR || path.join(root, "work"),
            `m27-composer-${width}.png`,
          ),
          fullPage: true,
        });
      },
      "",
      { width, height: 1000 },
    );

  for (const width of [390, 1440]) {
    const viewport = { width, height: 1000 };
    await test(
      `account controls and reconnect at ${width}px`,
      async (page) => {
        page.on("dialog", (dialog) => dialog.accept());
        await page.getByRole("heading", { name: "Fixture YouTube" }).waitFor();
        assert.equal(
          await page
            .getByRole("option", { name: "INSTAGRAM — unavailable", exact: true })
            .isDisabled(),
          true,
        );
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await page.waitForFunction(() =>
          window.m27Fixture.calls.some((call) => call.path.endsWith("/refresh")),
        );
        await page.getByRole("button", { name: "Check health", exact: true }).click();
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        await page.getByText(/REVOKED/).waitFor();
        await page.route("https://oauth.fixture.test/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<p>Fixture authorization handoff</p>" }),
        );
        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
        await page.getByText("Fixture authorization handoff").waitFor();
      },
      "mode=accounts",
      viewport,
    );
    await test(
      `viewer account controls unavailable at ${width}px`,
      async (page) => {
        await page.getByRole("heading", { name: "Fixture YouTube" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).count(), 0);
        assert.equal(
          await page.getByRole("button", { name: "Disconnect", exact: true }).count(),
          0,
        );
        assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).count(), 0);
      },
      "mode=accounts&role=VIEWER",
      viewport,
    );
    await test(
      `interrupted account action reconciles after reload at ${width}px`,
      async (page) => {
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await page
          .getByText("Previous account action may still be pending", { exact: true })
          .waitFor();
        await page.reload();
        assert.equal(
          await page.getByRole("button", { name: "Disconnect", exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await page.getByRole("button", { name: "I inspected the accounts" }).isDisabled(),
          true,
        );
        await page.getByRole("button", { name: "Refresh accounts", exact: true }).click();
        await page.getByRole("button", { name: "I inspected the accounts" }).click();
        assert.equal(
          await page.getByRole("button", { name: "Disconnect", exact: true }).isDisabled(),
          false,
        );
        assert.equal((await calls(page)).filter((call) => call.method === "POST").length, 0);
      },
      "mode=accounts-interrupted",
      viewport,
    );
    await test(
      `scheduled post edit and move to draft at ${width}px`,
      async (page) => {
        await page.getByLabel(/^Reschedule/).fill("2026-11-25T10:00");
        await page.getByRole("button", { name: "Reschedule", exact: true }).click();
        await page.waitForFunction(() =>
          window.m27Fixture.calls.some((call) => call.method === "PATCH"),
        );
        await page.getByRole("button", { name: "Move to draft", exact: true }).click();
        await page.getByText("Unscheduled draft").waitFor();
        const writes = (await calls(page)).filter((call) => call.method === "PATCH");
        assert.equal(writes.length, 2);
        assert.equal(JSON.parse(writes[1].body).scheduledAt, null);
      },
      "mode=scheduled",
      viewport,
    );
  }

  console.log(`PASS ${count} mounted M27 browser scenarios`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
