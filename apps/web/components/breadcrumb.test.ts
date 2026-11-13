import { describe, expect, it } from "vitest";
import { getBreadcrumb } from "./breadcrumb";

describe("getBreadcrumb", () => {
  it.each([
    ["/publishing", "Publishing"],
    ["/publishing/history", "Publishing"],
    ["/review", "Review"],
    ["/production/video", "Production"],
    ["/planning", "Planning"],
    ["/channels/one", "Channels"],
    ["/insights/videos", "Insights"],
    ["/operations", "Operations"],
    ["/account", "Account"],
    ["/", "Overview"],
    ["/unknown", "Overview"],
  ])("maps %s", (path, label) => expect(getBreadcrumb(path)).toBe(`Studio / ${label}`));
});
