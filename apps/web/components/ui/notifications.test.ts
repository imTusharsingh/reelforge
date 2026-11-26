// @vitest-environment jsdom
import { act, createElement, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationProvider, useNotify } from "./notifications";
import { Alert } from "./primitives";

const navigation = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({ usePathname: (): string => navigation.path }));

let container: HTMLDivElement, root: Root;
function Trigger({ blocker }: { blocker: boolean }): JSX.Element {
  const notify = useNotify();
  return createElement(
    "main",
    null,
    blocker &&
      createElement(Alert, {
        tone: "warning",
        title: "Run paused",
        children: "Resolve the existing blocker.",
      }),
    createElement(
      "button",
      { onClick: () => notify({ tone: "success", title: "Short saved." }) },
      "Success",
    ),
    createElement(
      "button",
      { onClick: () => notify({ tone: "danger", title: "Run failed", detail: "Try again." }) },
      "Error",
    ),
  );
}
async function render(blocker = false): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NotificationProvider, { children: createElement(Trigger, { blocker }) }),
    ),
  );
}
async function click(name: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  await act(async () => button!.click());
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  navigation.path = "/";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("Studio notifications", () => {
  it("replaces old feedback, clears success automatically, and keeps errors until dismissed", async () => {
    await click("Success");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Short saved.");
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click("Error");
    await click("Error");
    expect(container.querySelectorAll(".rf-notification")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Run failedTry again.");
    await click("Success");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("holds success while keyboard focus is inside and drops it when navigating", async () => {
    await click("Success");
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss notification: Short saved."]',
    )!;
    await act(async () => button.focus());
    await act(async () => vi.advanceTimersByTime(7000));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    navigation.path = "/publishing";
    await render();
    expect(container.querySelector(".rf-notifications")).toBeNull();
  });
  it("keeps a warning and action result in one inline region instead of adding a toast", async () => {
    await render(true);
    await click("Error");
    expect(container.querySelector(".rf-notifications")).toBeNull();
    const warning = container.querySelector(".rf-alert")!;
    expect(warning.textContent).toContain("Resolve the existing blocker.");
    expect(warning.querySelector(".rf-notification--inline")?.textContent).toBe(
      "Run failedTry again.",
    );
    await act(async () =>
      warning
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Run failed"]')!
        .click(),
    );
    expect(warning.textContent).not.toContain("Run failed");
    expect(warning.textContent).toContain("Run paused");
  });
});
