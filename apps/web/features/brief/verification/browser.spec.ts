import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capability, stubRun } from "../setup.fixture";
import type { ChannelBrief } from "../../../../../packages/contracts/src/foundations";
async function accessible(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function register(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Display name").fill("V7 creator");
  await page.getByLabel("Email address").fill(`v7-${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("V7-test-password-2026");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your first Short" })).toBeVisible();
}
test("sign-up, five inputs, queued run, immutable Brief and accessible settings", async ({
  page,
}) => {
  let workspaceId = "",
    channelId = "",
    runCalls = 0;
  const configured = { gemini: false, xai: false };
  await page.route("**/api/v1/runs", async (route) => {
    runCalls++;
    const body = route.request().postDataJSON() as {
      workspaceId: string;
      channelId: string;
      idempotencyKey: string;
    };
    workspaceId = body.workspaceId;
    channelId = body.channelId;
    const response = await page.request.get(
      `http://127.0.0.1:3301/api/v1/workspaces/${workspaceId}/channels/${channelId}/briefs`,
    );
    const briefs = (await response.json()) as ChannelBrief[];
    await route.fulfill({ status: 201, json: stubRun(briefs[0]!, body.idempotencyKey) });
  });
  await page.route("**/api/v1/workspaces/*/provider-keys**", async (route) => {
    const provider = route.request().url().split("/").at(-1);
    if (route.request().method() === "PUT" && (provider === "gemini" || provider === "xai")) {
      configured[provider] = true;
      await route.fulfill({ status: 204, body: "" });
    } else await route.fulfill({ json: configured });
  });
  await page.route("**/api/v1/workspaces/*/providers/capabilities", (route) =>
    route.fulfill({ json: [{ ...capability, workspaceId }] }),
  );
  await register(page);
  await accessible(page);
  expect(await page.locator("form input,form select").count()).toBe(5);
  await page.getByLabel("Niche or topic").fill("Science explainers");
  await page.getByLabel("Audience", { exact: true }).fill("Curious adults");
  await page.getByRole("button", { name: "Create channel and start first Short" }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  expect(runCalls).toBe(1);
  await page.goto(`/channels/${channelId}`);
  await expect(page.getByRole("heading", { name: "Channel Brief", exact: true })).toBeVisible();
  await expect(page.locator('option[value="L3"]')).toBeDisabled();
  await accessible(page);
  await page.getByLabel("topic", { exact: true }).fill("Space exploration");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Saved immutable Brief version 2.")).toBeVisible();
  await settings(page);
});

async function settings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Provider keys" })).toBeVisible();
  await accessible(page);
  await page.getByLabel("New gemini API key").fill("fixture-key-not-a-live-credential");
  await page.getByRole("button", { name: "Save gemini key" }).click();
  await expect(page.getByLabel("New gemini API key")).toHaveValue("");
  await expect(page.getByText("Configured", { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain("fixture-key-not-a-live-credential");
  await page.goto("/settings/providers");
  await expect(page.getByRole("table")).toBeVisible();
  await accessible(page);
}
