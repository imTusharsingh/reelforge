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
  it.each([
    { reason: "PUBLISH_DRY_RUN", timeline: "Publish simulated (dry run)", header: "Dry run" },
    { reason: null, timeline: "Published", header: "Published" },
  ])("labels the current publish step $timeline", async ({ reason, timeline, header }) => {
    const data = detail();
    data.run.state = "PUBLISHED";
    data.run.pauseReason = reason;
    fakeFetch(data);

    await act(async () => root.render(createElement(RunScreen, { id: runId })));
    expect(host.querySelector(".rf-page-heading .rf-badge")?.textContent).toBe(header);
    expect(host.querySelector(".rf-timeline [aria-current=step]")?.textContent).toBe(timeline);
    expect(host.querySelectorAll(".rf-timeline [aria-current=step]")).toHaveLength(1);
  });
  it.each(["assembly_input_failed", "assembly_failed", "shot_refused", "step_failed"])(
    "refreshes the open timeline on %s",
    async (event) => {
      const data = detail();
      data.run.state = "ASSEMBLING";
      const fetcher = fakeFetch();
      fetcher.mockImplementation(async () => Response.json(data));
      await act(async () => root.render(createElement(RunScreen, { id: runId })));
      const current = (): string | null | undefined =>
        host.querySelector(".rf-timeline [aria-current=step]")?.textContent;
      expect(current()).toBe("Assembling");
      data.run.state = "FAILED";
      await act(async () => FakeEventSource.instances[0]!.emit(event, 7));
      expect(current()).toBe("Failed");
    },
  );
  it("immediately shows the caption remedy when assembly pauses on a live event", async () => {
    const data = detail();
    data.run.state = "ASSEMBLING";
    const fetcher = fakeFetch(data);
    await act(async () => root.render(createElement(RunScreen, { id: runId })));
    expect(host.querySelector(".rf-timeline [aria-current=step]")?.textContent).toBe("Assembling");
    const before = fetcher.mock.calls.length;
    data.run.pauseReason = "SAVED_CAPTION_PLAN_UNUSABLE";
    await act(async () => FakeEventSource.instances[0]!.emit("assembly_input_failed", 7));
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    expect(host.querySelector(".rf-timeline [aria-current=step]")?.textContent).toBe(
      "Assembly paused",
    );
    expect(host.textContent).toContain("Start a new Short with shorter narration.");
    expect(host.textContent).not.toContain("SAVED_CAPTION_PLAN_UNUSABLE");
  });
  it("enables the remaining quality reshoot after a refusal rewrite and one requested redo", async () => {
    const data = detail();
    data.run.state = "CRITIC";
    const input = {
      id: crypto.randomUUID(),
      schemaVersion: "1.0",
      workspaceId,
      runId,
      ordinal: 0,
      version: 1,
      keyframePrompt: "Tree",
      motionPrompt: "Pan",
      negativePrompt: "",
      durationSeconds: 5,
      voLine: "Leaves",
      dialogue: "",
      onScreenText: "",
      continuityNotes: [],
      firstFrameFrom: null,
      camera: "wide",
      transition: "cut",
      references: [],
      width: 720,
      height: 1280,
      fps: 24,
      seed: null,
    };
    for (const attempt of [1, 2, 3])
      data.steps.push({
        ...data.steps[0]!,
        id: crypto.randomUUID(),
        key: "shot-0",
        input,
        attempt,
        state: attempt === 1 ? "SKIPPED" : "SUCCEEDED",
        output:
          attempt === 2
            ? { refusalRewrite: { sourceStepId: data.steps[1]!.id, providerId: "gemini" } }
            : {},
      });
    const remainingReshoots = { "shot-0": 1 };
    const fetcher = fakeFetch();
    fetcher.mockImplementation(async () => Response.json({ ...data, remainingReshoots }));
    await act(async () => root.render(createElement(RunScreen, { id: runId })));
    const redo = (): HTMLButtonElement | undefined =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Redo shot");
    expect(redo()?.disabled).toBe(false);
    await act(async () => redo()!.click());
    expect(
      fetcher.mock.calls.some(([path]) => String(path).includes(`runs/${runId}/reshoot/0`)),
    ).toBe(true);
    remainingReshoots["shot-0"] = 0;
    await act(async () => FakeEventSource.instances[0]!.emit("reshoot_requested", 8));
    expect(redo()?.disabled).toBe(true);
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
  it("counts the latest 100 Shorts and lists actionable pauses without counting dry runs as published", async () => {
    const base = detail().run;
    const run = (state: typeof base.state, pauseReason: string | null = null): typeof base => ({
      ...base,
      id: crypto.randomUUID(),
      state,
      pauseReason,
    });
    const stopped = run("GENERATING", "EMERGENCY_STOP");
    const pending = run("AWAITING_APPROVAL");
    const dryRun = run("PUBLISHED", "PUBLISH_DRY_RUN");
    const learnedDryRun = run("LEARNING", "PUBLISH_DRY_RUN");
    const rejected = run("AWAITING_APPROVAL", "HUMAN_REJECTED");
    const canceled = run("CANCELED");
    const canceledWithBillingHold = run(
      "CANCELED",
      "RECONCILE_REQUIRED: provider billing exceeded reservation (video step)",
    );
    const canceledWithUnknownOutcome = run("CANCELED", "RECONCILE_REQUIRED");
    const runs = [
      stopped,
      pending,
      dryRun,
      learnedDryRun,
      run("PUBLISHED"),
      run("LEARNING"),
      rejected,
      canceled,
      canceledWithBillingHold,
      canceledWithUnknownOutcome,
    ];
    fakeFetch().mockImplementation(async (url: string): Promise<Response> => {
      if (url.includes("/run-experience?")) return Response.json(runs);
      const selected = runs.find((item) => url.includes(item.id));
      return Response.json({ ...detail(), run: selected ?? base });
    });

    await act(async () => root.render(createElement(RunList)));
    expect(host.querySelector("#workspace-snapshot-heading")?.textContent).toBe(
      "Latest 100 Shorts",
    );
    const stats = Object.fromEntries(
      Array.from(host.querySelectorAll(".rf-snapshot > div"), (element) => [
        element.querySelector("dt")?.textContent?.trim(),
        element.querySelector("dd")?.textContent,
      ]),
    );
    expect(stats).toEqual({ "Shorts loaded": "10", "Needs attention": "4", Published: "2" });
    expect(host.querySelector(`a[href="/runs/${dryRun.id}"]`)?.textContent).toContain("Dry run");

    await act(async () => root.render(createElement(RunList, { inbox: true })));
    expect(
      Array.from(host.querySelectorAll(".rf-run-tile a"), (link) => link.getAttribute("href")),
    ).toEqual([
      `/runs/${stopped.id}/review`,
      `/runs/${pending.id}/review`,
      `/runs/${canceledWithBillingHold.id}/review`,
      `/runs/${canceledWithUnknownOutcome.id}/review`,
    ]);
    const heldCard = host.querySelector(`a[href="/runs/${canceledWithBillingHold.id}/review"]`);
    expect(heldCard?.textContent).toContain("Canceled");
    expect(heldCard?.textContent).toContain(
      "Provider reconciliation required: provider billing exceeded reservation (video step)",
    );
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
