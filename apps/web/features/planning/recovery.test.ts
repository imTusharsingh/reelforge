// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PendingSaveRecovery } from "./session";
import type { PlanningClient, SaveReconciliation } from "./model";

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
function fixture(fail = false): {
  client: PlanningClient;
  reconcile: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
} {
  const reconcile = fail
    ? vi.fn().mockRejectedValue(new Error("Read failed"))
    : vi.fn().mockResolvedValue({ resource: "script", snapshot: {} });
  const acknowledge = vi.fn();
  return {
    client: {
      signal: new AbortController().signal,
      reconcilePendingSave: reconcile,
      acknowledgePendingSave: acknowledge,
    } as unknown as PlanningClient,
    reconcile,
    acknowledge,
  };
}
it("reconciles in the background without a manual confirmation", async () => {
  const { client, reconcile, acknowledge } = fixture();
  const onReconciled = vi.fn();
  await act(async () =>
    root.render(createElement(PendingSaveRecovery, { client, revision: 0, onReconciled })),
  );
  expect(reconcile).toHaveBeenCalledOnce();
  expect(acknowledge).toHaveBeenCalledOnce();
  expect(onReconciled).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("I have compared");
});
it("keeps an unsuccessful background check informational and allows retry without dismissal", async () => {
  const { client, reconcile, acknowledge } = fixture(true);
  const onReconciled = vi.fn();
  await act(async () =>
    root.render(createElement(PendingSaveRecovery, { client, revision: 0, onReconciled })),
  );
  expect(host.textContent).toContain("Read failed");
  expect(host.textContent).toContain("You can retry your action");
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(false);
  reconcile.mockResolvedValueOnce({ resource: "script", snapshot: {} });
  await act(async () => button.click());
  expect(acknowledge).toHaveBeenCalledOnce();
  expect(onReconciled).toHaveBeenCalledOnce();
});
it("does not acknowledge an obsolete read after the recovery panel is unmounted", async () => {
  const { client, reconcile, acknowledge } = fixture();
  let finish!: (value: SaveReconciliation) => void;
  reconcile.mockReturnValue(
    new Promise<SaveReconciliation>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    root.render(createElement(PendingSaveRecovery, { client, revision: 0, onReconciled: vi.fn() })),
  );
  await act(async () => root.render(createElement("p", null, "Elsewhere")));
  await act(async () => finish({ resource: "script", snapshot: {} }));
  expect(acknowledge).not.toHaveBeenCalled();
});
