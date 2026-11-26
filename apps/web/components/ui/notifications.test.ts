// @vitest-environment jsdom
import { act, createElement, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationProvider, useNotify } from "./notifications";

let container: HTMLDivElement, root: Root;
function Trigger(): JSX.Element {
  const notify = useNotify();
  return createElement(
    "button",
    {
      onClick: () => {
        notify({ tone: "success", title: "Short saved." });
        notify({ tone: "danger", title: "Run failed", detail: "Try again." });
      },
    },
    "Trigger",
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(NotificationProvider, { children: createElement(Trigger) })),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Studio notifications", () => {
  it("announces action feedback, quietly clears success, and keeps errors until dismissed", async () => {
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Short saved.");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Run failedTry again.");
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Run failed"]')!
        .click(),
    );
    expect(container.querySelector('[aria-label="Notifications"]')).toBeNull();
  });

  it("deduplicates repeat messages and does not time out while keyboard focus is inside", async () => {
    await act(async () => {
      container.querySelector("button")!.click();
      container.querySelector("button")!.click();
    });
    expect(container.querySelectorAll(".rf-notification")).toHaveLength(2);
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss notification: Short saved."]',
    )!;
    await act(async () => button.focus());
    await act(async () => vi.advanceTimersByTime(7000));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => button.blur());
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
