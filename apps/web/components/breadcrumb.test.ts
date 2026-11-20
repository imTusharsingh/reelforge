import { describe, expect, it } from "vitest";
import { getBreadcrumb } from "./breadcrumb";

describe("getBreadcrumb", () => {
  it.each([
    ["/publishing", "Publishing"],
    ["/publishing/history", "Publishing"],
    ["/channels/one", "Channels"],
    ["/insights/videos", "Insights"],
    ["/runs/example", "Run timeline"],
    ["/approvals", "Approval inbox"],
    ["/usage", "Usage"],
    ["/account", "Account"],
    ["/", "Overview"],
    ["/unknown", "Overview"],
  ])("maps %s", (path, label) => expect(getBreadcrumb(path)).toBe(`Studio / ${label}`));
});
