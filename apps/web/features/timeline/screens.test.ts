// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunScreen } from "./run-screen";
import { RunList } from "./run-list";
import { AutonomyPanel } from "./autonomy-panel";
import { detail, FakeEventSource, runId, workspaceId } from "./timeline.fixture";
vi.mock("../../components/studio-workspace-context", () => ({
  useActiveWorkspace: (): { id: string; role: string } => ({ id: workspaceId, role: "OWNER" }),
}));
vi.mock("../../components/studio-link", () => ({
  StudioLink: ({ children, href }: { children: ReactNode; href: string }): ReactNode =>
    createElement("a", { href }, children),
}));
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
function fakeFetch(runDetail = detail()): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn(async (url: string): Promise<Response> => {
    if (url.includes("/autonomy"))
      return Response.json({
        approvedShorts: 10,
        offerL3: true,
        effective: "L2",
        agreements: 8,
        samples: 10,
        recommended: true,
      });
    if (url.includes("/run-experience?")) return Response.json([detail().run]);
    return Response.json(runDetail);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("V8 mounted experience with fake HTTP", () => {
  it("renders run steps, critic, spend, autonomy offer and storyboard", async () => {
    fakeFetch();
    await act(async () => root.render(createElement(RunScreen, { id: runId })));
    expect(host.textContent).toContain("$5.79 used of $8.00 cap");
    expect(host.querySelectorAll(".rf-timeline li")).toHaveLength(14);
    expect(host.textContent).toContain("Storyboard");
    expect(host.textContent).toContain("8/10");
    expect(host.textContent).toContain("Try full auto");
    expect(host.textContent).toContain("Ready to publish");
  });
  it("offers resume at final review after an emergency stop", async () => {
    const data = detail();
    data.run.pauseReason = "EMERGENCY_STOP";
    const fetcher = fakeFetch(data);
    await act(async () => root.render(createElement(RunScreen, { id: runId, review: true })));
    const resume = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Resume run",
    );
    expect(resume).toBeDefined();
    await act(async () => resume!.click());
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/resume?workspaceId=${workspaceId}`,
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("routes review cards to review and shows costs on the dashboard", async () => {
    fakeFetch();
    await act(async () => root.render(createElement(RunList, { inbox: true })));
    expect(host.textContent).toContain("Review queue");
    expect(host.querySelector(`a[href="/runs/${runId}/review"]`)).not.toBeNull();
    await act(async () => root.render(createElement(RunList)));
    expect(host.querySelector(`a[href="/runs/${runId}"]`)).not.toBeNull();
    expect(host.textContent).toContain("$5.79");
  });
  it("offers explicit L3 selection after ten, and posts selection without auto enabling it", async () => {
    const fetcher = fakeFetch();
    const data = detail();
    data.run.state = "PLANNING";
    data.run.approvedShortsAtStart = 10;
    const refresh = vi.fn();
    await act(async () =>
      root.render(
        createElement(AutonomyPanel, { workspaceId, run: data.run, editable: true, refresh }),
      ),
    );
    expect(host.querySelector("select")?.value).toBe("L2");
    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = "L3";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/auth/csrf"))).toBe(true);
  });
  it("blocks L3 before ten and reports failed HTTP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Unavailable" }, { status: 503 })),
    );
    const data = detail();
    data.run.state = "PLANNING";
    await act(async () =>
      root.render(
        createElement(AutonomyPanel, {
          workspaceId,
          run: data.run,
          editable: true,
          refresh: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector<HTMLOptionElement>('option[value="L3"]')?.disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
  });
});
