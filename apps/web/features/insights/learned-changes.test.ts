// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnedChanges } from "./learned-changes";
const DEFAULT_WEIGHTS = {
  novelty: 0.2,
  trendVelocity: 0.15,
  briefFit: 0.25,
  predictedRetention: 0.2,
  costFeasibility: 0.1,
  policySafety: 0.1,
};

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount(response: unknown, ok = true): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async (): Promise<unknown> => response }),
  );
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => {
    root!.render(createElement(LearnedChanges, { workspaceId: "workspace", channelId: "channel" }));
  });
  return node;
}
describe("existing /insights learned changes panel", () => {
  it("shows audited before/after weights and format mix with evidence", async () => {
    const before = { weights: DEFAULT_WEIGHTS, formatMix: { explainer: 0.5, story: 0.5 } },
      after = {
        weights: { ...DEFAULT_WEIGHTS, novelty: 0.25, briefFit: 0.2 },
        formatMix: { explainer: 0.55, story: 0.45 },
      };
    const node = await mount([
      {
        id: "66666666-6666-4666-8666-666666666666",
        createdAt: "2026-11-16T00:00:00Z",
        week: "2026-11-16",
        mode: "APPLIED",
        reason: "Retention evidence",
        before,
        after,
        evidenceSnapshotIds: ["77777777-7777-4777-8777-777777777777"],
      },
    ]);
    expect(node.textContent).toContain("What the AI learned");
    expect(node.textContent).toContain("Applied learning");
    expect(node.textContent).toContain("0.200 → 0.250");
    expect(node.textContent).toContain("0.500 → 0.550");
    expect(node.textContent).toContain("77777777-7777-4777-8777-777777777777");
    expect(node.textContent).toContain("remain recommendations");
    expect(fetch).toHaveBeenCalledWith("/api/v1/workspaces/workspace/channels/channel/learning", {
      credentials: "include",
    });
  });
  it("shows honest empty, invalid-response and access failure states", async () => {
    expect((await mount([])).textContent).toContain("No learned changes yet");
    await act(async () => root!.unmount());
    root = undefined;
    expect((await mount({ invalid: true })).textContent).toContain("unavailable");
    await act(async () => root!.unmount());
    root = undefined;
    expect((await mount([], false)).textContent).toContain("unavailable");
  });
});
