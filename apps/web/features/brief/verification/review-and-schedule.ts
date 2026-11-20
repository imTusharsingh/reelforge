import { expect, type Page } from "@playwright/test";
import type { AutoSlotView } from "../../../../../packages/contracts/src/publishing-automation";
import { detail } from "../../timeline/timeline.fixture";

export async function reviewAndSchedule(
  page: Page,
  { workspaceId, channelId, runId }: { workspaceId: string; channelId: string; runId: string },
  accessible: (page: Page) => Promise<void>,
): Promise<void> {
  // Fulfill paid-stage outputs and the scheduling handoff at the browser boundary.
  // Signup, Brief creation and VideoRun enqueue have already gone through the real API.
  const runDetail = detail();
  Object.assign(runDetail.run, { id: runId, channelId });
  const scheduledAt = "2027-03-14T07:00:00.000Z";
  const slot: AutoSlotView = {
    id: "00000000-0000-4000-8000-000000000006",
    runId,
    channelId,
    scheduledAt,
    timezone: "America/New_York",
    status: "SCHEDULED",
    scheduledPostId: "00000000-0000-4000-8000-000000000007",
    lastError: null,
    package: {
      renderJobId: "00000000-0000-4000-8000-000000000008",
      qualityReviewRunId: "00000000-0000-4000-8000-000000000009",
      title: "Science Short",
      description: "Offline publishing fixture",
      tags: ["science"],
      coverFrame: "cover.png",
      containsSyntheticMedia: true,
    },
  };
  let approved = false;
  await page.route(`**/api/v1/runs/${runId}?workspaceId=${workspaceId}`, (route) =>
    route.fulfill({ json: runDetail }),
  );
  await page.route(`**/api/v1/runs/${runId}/events?workspaceId=${workspaceId}`, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": offline fixture\n\n" }),
  );
  await page.route(
    `**/api/v1/workspaces/${workspaceId}/run-experience/${runId}/decision?workspaceId=${workspaceId}`,
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ decision: "APPROVE" });
      approved = true;
      await route.fulfill({ status: 204 });
    },
  );
  await page.route(`**/api/v1/workspaces/${workspaceId}/publishing/automation`, (route) =>
    route.fulfill({ json: approved ? [slot] : [] }),
  );

  await page.goto(`/runs/${runId}/review`);
  await expect(page.getByRole("heading", { name: "Review Short" })).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve Short" });
  await expect(approve).toBeEnabled();
  await accessible(page);
  await approve.click();
  await expect(page.getByText("Approved. Ready for scheduling.")).toBeVisible();
  await page.goto("/publishing");
  await expect(page.getByRole("heading", { name: "Publishing schedule" })).toBeVisible();
  await expect(page.getByRole("link", { name: slot.package.title })).toBeVisible();
  await expect(page.locator("time")).toHaveAttribute("datetime", scheduledAt);
  await accessible(page);
}
