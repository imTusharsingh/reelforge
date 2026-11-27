// @vitest-environment jsdom
import { act, createElement, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationProvider } from "../../components/ui/notifications";
import { ApprovalPanel } from "./approval-panel";
import { useRun } from "../timeline/use-run";
import { detail, FakeEventSource, runId, workspaceId } from "../timeline/timeline.fixture";
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});
function Harness(): JSX.Element {
  const { detail: data, connection } = useRun(workspaceId, runId);
  return createElement("p", null, connection, " ", data?.run.state);
}
describe("mobile approval UI on fake transport", () => {
  it.each(["Approve Short", "Reject Short"])("sends %s with one tap", async (label) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const refresh = vi.fn();
    await act(async () =>
      root.render(
        createElement(NotificationProvider, {
          children: createElement(ApprovalPanel, {
            detail: detail(),
            workspaceId,
            editable: true,
            refresh,
          }),
        }),
      ),
    );
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    expect(host.textContent).toContain("The first 10 Shorts require human approval");
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[1]?.[1]?.body).toContain(
      label === "Approve Short" ? "APPROVE" : "REJECT",
    );
    expect(
      host.querySelector(
        label === "Approve Short" ? '.rf-notification [role="status"]' : '.rf-alert[role="status"]',
      ),
    ).not.toBeNull();
  });
  it("renders packaged metadata and the retained assembly preview", async () => {
    const data = detail();
    const packaging = {
      title: "A real Short",
      description: "A sample description",
      tags: ["science"],
      coverFrameTimestampMs: 1000,
      containsSyntheticMedia: true,
    };
    data.steps.push({
      ...data.steps[0]!,
      key: "quality:packaging",
      output: { result: { packaging } },
    });
    data.artifactUrls.push({
      stepId: "00000000-0000-4000-8000-000000000009",
      artifacts: [
        { kind: "final", contentType: "video/mp4", url: "/api/v1/runs/video" },
        { kind: "refs", contentType: "image/jpeg", url: "/api/v1/runs/cover" },
      ],
    });
    await act(async () =>
      root.render(
        createElement(ApprovalPanel, {
          detail: data,
          workspaceId,
          editable: true,
          refresh: vi.fn(),
        }),
      ),
    );
    expect(host.textContent).toContain(packaging.title);
    expect(host.textContent).toContain(packaging.description);
    expect(host.textContent).toContain(packaging.tags[0]);
    expect(host.querySelector("video")?.getAttribute("src")).toBe("/api/v1/runs/video");
    expect(host.querySelector('img[alt="Short thumbnail"]')?.getAttribute("src")).toBe(
      "/api/v1/runs/cover",
    );
  });
  it("blocks missing gate approval, permits rejection, and hides viewer actions", async () => {
    const data = detail();
    data.steps = [];
    await act(async () =>
      root.render(
        createElement(ApprovalPanel, {
          detail: data,
          workspaceId,
          editable: true,
          refresh: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector("button")?.disabled).toBe(true);
    expect(host.textContent).toContain("unavailable");
    await act(async () =>
      root.render(
        createElement(ApprovalPanel, {
          detail: data,
          workspaceId,
          editable: false,
          refresh: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector("button")).toBeNull();
  });
  it("updates a mounted timeline on named SSE without a page refresh", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(detail()));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(Harness)));
    expect(host.textContent).toContain("AWAITING_APPROVAL");
    const updated = detail();
    updated.run.state = "SCHEDULED";
    fetcher.mockResolvedValueOnce(Response.json(updated));
    await act(async () => FakeEventSource.instances[0]!.emit("approved", 2));
    expect(host.textContent).toContain("SCHEDULED");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
