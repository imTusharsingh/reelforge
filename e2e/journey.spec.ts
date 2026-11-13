import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type TestInfo } from "@playwright/test";

type Seed = {
  width: number;
  email: string;
  workspaceId: string;
  channelId: string;
  ideaId: string;
  configSnapshotId: string;
  promptSnapshotId: string;
  assetId: string;
};
async function accessible(page: Page, info: TestInfo, flow: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  await info.attach(`axe-${flow}`, {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(
    result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
    `${flow}: serious/critical accessibility violations`,
  ).toEqual([]);
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({
        element: element.outerHTML.slice(0, 240),
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
      }))
      .filter((element) => element.right > window.innerWidth + 1)
      .slice(0, 10),
  }));
  expect(
    overflow.documentWidth,
    `${flow}: horizontal overflow ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.viewportWidth);
}

test("real studio journey with offline providers", async ({ page }, info) => {
  const seeds = JSON.parse(
    await readFile(join(process.env.E2E_STORAGE_ROOT!, "seed.json"), "utf8"),
  ) as Seed[];
  const seed = seeds.find((item) => item.width === info.project.use.viewport?.width)!;
  const errors: string[] = [],
    outbound: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !["http://127.0.0.1:3300", "http://127.0.0.1:3301"].includes(url.origin)
    ) {
      outbound.push(url.origin);
      await route.abort();
    } else await route.continue();
  });
  await test.step("sign in", async () => {
    await page.goto("/");
    await page.getByLabel("Email address", { exact: true }).fill(seed.email);
    await page.getByLabel("Password", { exact: true }).fill("E2e-only-password-79!");
    await accessible(page, info, "sign-in");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`E2E Owner ${seed.width}`) }).click();
    await expect(page.getByRole("button", { name: "Switch workspace" })).toBeVisible();
  });
  await test.step("workspace roles", async () => {
    await accessible(page, info, "owner-workspace");
    for (const role of ["EDITOR", "VIEWER"]) {
      await page.getByRole("button", { name: "Switch workspace" }).click();
      await page.getByRole("button", { name: new RegExp(`E2E ${role} ${seed.width}`) }).click();
      await page.goto("/channels");
      const create = page.getByRole("button", { name: "Create channel", exact: true });
      if (role === "VIEWER") await expect(create).toBeDisabled();
      else {
        await page.getByLabel("Channel name", { exact: true }).fill("Editor channel");
        await create.click();
        await expect(page.getByRole("link", { name: /Editor channel/ })).toBeVisible();
      }
      await accessible(page, info, `${role.toLowerCase()}-workspace`);
    }
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("button", { name: new RegExp(`E2E Owner ${seed.width}`) }).click();
  });
  await test.step("channel and brand", async () => {
    await page.goto("/channels");
    await page.getByLabel("Channel name", { exact: true }).fill("New brand channel");
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    await page.getByRole("link", { name: /New brand channel/ }).click();
    await page.getByRole("tab", { name: "Brand & identity" }).click();
    await page.getByLabel("Niche", { exact: true }).fill("Education");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Saved by the server.", { exact: true })).toBeVisible();
    await accessible(page, info, "channel-brand");
  });
  let scriptId = "";
  await test.step("M24 script creation and approval", async () => {
    await page.goto(`/planning/ideas/${seed.ideaId}`);
    await page
      .getByLabel("Generation configuration snapshot", { exact: true })
      .selectOption(seed.configSnapshotId);
    await page
      .getByLabel("Matching prompt bundle snapshot", { exact: true })
      .selectOption(seed.promptSnapshotId);
    await page
      .getByLabel("Additional generation instructions (not saved)")
      .fill("Create an offline blue scene.");
    await page.getByRole("button", { name: "Generate script", exact: true }).click();
    await page.getByRole("link", { name: /Open.*script/i }).click();
    await page.waitForURL(/\/planning\/scripts\/[0-9a-f-]+$/);
    scriptId = page.url().split("/").at(-1)!;
    await page.getByRole("button", { name: "Approve saved script", exact: true }).click();
    await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
    await accessible(page, info, "script-create");
  });
  await test.step("generation studio and C3 assignment", async () => {
    await page.goto(`/production/scripts/${scriptId}`);
    await page.getByRole("button", { name: "Start scene generation", exact: true }).click();
    await page.waitForURL(/\/production\/jobs\//);
    await page
      .getByLabel("Assign existing asset", { exact: true })
      .selectOption(`${seed.assetId}:1`);
    await page.getByRole("button", { name: "Assign asset", exact: true }).click();
    await expect(page.getByText("ASSIGNED", { exact: true }).first()).toBeVisible();
    await accessible(page, info, "generation-assignment");
  });
  await test.step("C4 render start", async () => {
    await page.getByRole("button", { name: "Start render", exact: true }).click();
    await page.getByRole("link", { name: "Open render", exact: true }).click();
    await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("link", { name: "Download video" })).toBeVisible();
    await accessible(page, info, "render-start");
  });
  await test.step("quality approval", async () => {
    await page.goto("/review");
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
      await expect(page.getByRole("link", { name: /Inspect evidence/ }).first()).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await page
      .getByRole("link", { name: /Inspect evidence/ })
      .first()
      .click();
    await page.getByLabel("Decision", { exact: true }).selectOption("APPROVE");
    await page
      .getByLabel("Decision reason", { exact: true })
      .fill("Human approval of deterministic local test media.");
    await page.getByRole("button", { name: "Record decision", exact: true }).click();
    await expect(page.getByText("approved", { exact: true }).first()).toBeVisible();
    await accessible(page, info, "quality-approval");
  });
  await test.step("M27 publishing composer and calendar", async () => {
    await page.goto("/publishing/new");
    await page.getByLabel("Approved render", { exact: true }).selectOption({ index: 1 });
    await page.getByRole("checkbox", { name: /E2E YouTube/ }).check();
    await page
      .getByLabel("YouTube description", { exact: true })
      .fill("Offline publishing draft; never uploaded.");
    await page.getByLabel("Disclosure reason", { exact: true }).fill("Test fixture media.");
    await accessible(page, info, "publishing-composer");
    await page.getByRole("button", { name: "Create scheduled post", exact: true }).click();
    await expect(page.getByText(/Preflight/).first()).toBeVisible();
    await page.goto("/publishing");
    await expect(
      page.getByRole("link", { name: "Inspect post", exact: true }).first(),
    ).toBeVisible();
    await accessible(page, info, "publishing-calendar");
  });
  await test.step("C5 account settings", async () => {
    await page.goto("/account");
    await page.getByLabel("Display name", { exact: true }).fill(`E2E Creator ${seed.width}`);
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.getByText("Profile updated.", { exact: true })).toBeVisible();
    await page.getByLabel("Current password", { exact: true }).fill("E2e-only-password-79!");
    await page.getByLabel("New password", { exact: true }).fill("Changed-e2e-password-79!");
    await page.getByLabel("Confirm new password", { exact: true }).fill("Changed-e2e-password-79!");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
    await accessible(page, info, "account-settings");
  });
  expect(outbound, "No external browser network requests").toEqual([]);
  expect(errors, "No uncaught browser errors").toEqual([]);
});
