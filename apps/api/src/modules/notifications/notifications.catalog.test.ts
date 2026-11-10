import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_EVENT_TYPES,
  audienceIncludes,
} from "./notifications.catalog.js";
import { NOTIFICATION_LINK_ROUTES, buildNotificationLink } from "./notifications.links.js";
import { DEFAULT_NOTIFICATIONS_CONFIG, deliveryBackoffMs } from "./notifications.ports.js";

describe("M17 notification catalog", () => {
  it("covers the approved M11/M13/M14-M15/M16/M17 event types", () => {
    expect([...NOTIFICATION_EVENT_TYPES].sort()).toEqual(
      [
        "REVIEW_NEEDED",
        "REVIEW_APPROVED",
        "REVIEW_REJECTED",
        "PUBLISH_SUCCEEDED",
        "PUBLISH_FAILED",
        "PUBLISH_RECONCILIATION_REQUIRED",
        "RUN_FAILED",
        "RUN_RECONCILIATION_REQUIRED",
        "RUN_WAITING_APPROVAL",
        "RUN_SUCCEEDED",
        "ANALYTICS_REPORT_READY",
        "CHANNEL_REPORT_READY",
      ].sort(),
    );
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const entry = NOTIFICATION_EVENT_CATALOG[type];
      expect(entry.title({}).length).toBeGreaterThan(0);
      expect(entry.body({}).length).toBeGreaterThan(0);
      expect(NOTIFICATION_LINK_ROUTES[entry.linkKind]).toMatch(/^\/workspaces\/:workspaceId\//);
    }
  });

  it("limits action-required events to editors", () => {
    expect(audienceIncludes(NOTIFICATION_EVENT_CATALOG.REVIEW_NEEDED.audience, "VIEWER")).toBe(
      false,
    );
    expect(audienceIncludes(NOTIFICATION_EVENT_CATALOG.REVIEW_NEEDED.audience, "EDITOR")).toBe(
      true,
    );
    expect(audienceIncludes(NOTIFICATION_EVENT_CATALOG.RUN_FAILED.audience, "VIEWER")).toBe(true);
  });

  it("builds relative deep links and rejects unsafe parameters", () => {
    const ws = "4f8f5a52-62b5-4a43-9a8b-6f0a3f7f1c11";
    const run = "1b0c4b7e-8f0e-4f9f-a2c4-3a0f5d6e7b8c";
    expect(buildNotificationLink("workflowRun", { workspaceId: ws, runId: run })).toBe(
      `/workspaces/${ws}/orchestration/runs/${run}`,
    );
    expect(() =>
      buildNotificationLink("reviewItem", { workspaceId: ws, reviewRunId: "../x" }),
    ).toThrow();
    expect(() => buildNotificationLink("publishedPost", { workspaceId: ws })).toThrow();
  });

  it("backs off exponentially up to the cap", () => {
    const config = DEFAULT_NOTIFICATIONS_CONFIG;
    expect(deliveryBackoffMs(config, 1)).toBe(60_000);
    expect(deliveryBackoffMs(config, 3)).toBe(240_000);
    expect(deliveryBackoffMs(config, 20)).toBe(3_600_000);
  });
});
