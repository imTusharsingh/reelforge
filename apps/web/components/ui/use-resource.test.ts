// @vitest-environment jsdom
import { act, createElement, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useResource } from "./use-resource";

function Resources({ load }: { load: () => Promise<string> }): JSX.Element {
  const { data, error, loading, retry } = useResource(load);
  return createElement(
    "div",
    null,
    loading ? "loading" : "settled",
    createElement("span", null, data ?? "none"),
    createElement("span", null, error),
    createElement("button", { onClick: retry }, "Retry"),
  );
}

it("keeps previously loaded content, coalesces rapid retries and clears stale errors after recovery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  let settle!: (value: string) => void;
  const load = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("previous data")
    .mockRejectedValueOnce(new Error("network failed"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
  try {
    await act(async () => root.render(createElement(Resources, { load })));
    expect(host.textContent).toContain("previous data");
    const retry = host.querySelector("button")!;
    await act(async () => retry.click());
    expect(host.textContent).toContain("network failed");
    expect(host.textContent).toContain("previous data");
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("loading");
    await act(async () => settle("updated data"));
    expect(host.textContent).not.toContain("network failed");
    expect(host.textContent).toContain("updated data");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
