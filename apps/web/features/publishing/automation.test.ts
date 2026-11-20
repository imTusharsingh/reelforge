// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCalendar } from "./automation-calendar";
import { AutomationComposer } from "./automation-composer";
import { autoSlots, automationRequest } from "./automation-api";
vi.mock("../../components/studio-workspace-context", () => ({
  useActiveWorkspace: (): { id: string; role: string } => ({ id: "workspace", role: "OWNER" }),
}));
vi.mock("../../components/studio-link", () => ({
  StudioLink: ({ href, children }: { href: string; children: ReactNode }): ReactNode =>
    createElement("a", { href }, children),
}));
const uuid = "11111111-1111-4111-8111-111111111111";
const slot = {
  id: uuid,
  runId: uuid,
  channelId: uuid,
  scheduledAt: "2027-03-14T07:00:00.000Z",
  timezone: "America/New_York",
  status: "NEEDS_HUMAN",
  scheduledPostId: uuid,
  lastError: "RECONNECT_YOUTUBE",
  package: {
    renderJobId: uuid,
    qualityReviewRunId: uuid,
    title: "Science",
    description: "Original story",
    tags: ["science"],
    coverFrame: "cover.png",
    containsSyntheticMedia: true,
  },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
describe("V9 automatic calendar and prefilled composer with fake HTTP", () => {
  it("shows the channel-zone slot and packaged title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([slot])),
    );
    await act(async () => root.render(createElement(AutomationCalendar)));
    expect(host.querySelector("h1")?.textContent).toBe("Publishing schedule");
    expect(host.querySelector("time")?.dateTime).toBe(slot.scheduledAt);
    expect(host.textContent).toContain("Science");
    expect(host.textContent).toContain("America/New_York");
    expect(host.querySelector(`a[href="/publishing/new?autoSlot=${uuid}"]`)).not.toBeNull();
  });
  it("prefills metadata and offers existing OAuth reconnect with a fenced reconciliation action", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(slot));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(AutomationComposer, { id: uuid })));
    expect(host.querySelector("input")?.value).toBe("Science");
    expect(host.querySelector("textarea")?.value).toBe("Original story");
    expect(host.querySelector('a[href="/publishing/accounts"]')).not.toBeNull();
    await act(async () => host.querySelector("button")!.click());
    expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith(`/${uuid}/retry`))).toBe(
      true,
    );
  });
  it("validates server output and reports HTTP failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(autoSlots("workspace")).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(automationRequest("workspace")).rejects.toThrow("403");
  });
});
