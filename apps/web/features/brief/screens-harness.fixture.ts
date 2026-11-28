import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { WorkspaceProvider } from "../../components/studio-workspace-context";
import { setupStub, workspaceId } from "./setup.fixture";
export let root: Root, container: HTMLDivElement;
export let stub: ReturnType<typeof setupStub>;
export async function render(node: ReactNode): Promise<void> {
  await act(async () =>
    root.render(
      createElement(WorkspaceProvider, {
        workspace: { id: workspaceId, name: "Science", role: "OWNER" },
        children: node,
      }),
    ),
  );
}
export async function change(selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(selector)!;
  const proto =
    element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : element.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
export async function submit(selector = "form"): Promise<void> {
  await act(async () =>
    container.querySelector(selector)!.dispatchEvent(
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: container.querySelector('button[value="queue"]'),
      }),
    ),
  );
}
export async function submitOnboardingConfirm(): Promise<void> {
  await change("#setup-niche", "Science");
  await change("#setup-audience", "Adults");
  for (let step = 0; step < 3; step++) await submit();
}
beforeEach(() => {
  history.replaceState(null, "", "/onboarding");
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stub = setupStub();
  vi.stubGlobal("fetch", stub.fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
