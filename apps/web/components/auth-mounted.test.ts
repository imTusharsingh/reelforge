// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../lib/api";
import { AuthForm } from "./auth-form";
import { AuthWorkspace } from "./auth-workspace";
vi.mock("./app-shell", () => ({
  AppShell: ({
    children,
    inspector,
    shellActions,
  }: {
    children: ReactNode;
    inspector: ReactNode;
    shellActions: ReactNode;
  }): ReactNode => createElement("main", null, inspector, shellActions, children),
}));
let container: HTMLDivElement, root: Root;
async function mount(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}
async function click(text: string): Promise<void> {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === text)!
      .click();
  });
}
async function fill(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(): Promise<void> {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("authentication and Channel Brief setup", () => {
  it("signs in, toggles visibility, validates registration and reports safe failures", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue({ userId: "user" });
    const register = vi.spyOn(api, "register").mockResolvedValue({ userId: "user" });
    const done = vi.fn().mockResolvedValue(undefined);
    await mount(createElement(AuthForm, { onAuthenticated: done }));
    await submit();
    expect(container.textContent).toContain("email");
    await fill("email", "creator@example.com");
    await fill("password", "long-password-2026");
    await click("Show");
    expect(container.querySelector<HTMLInputElement>("#password")!.type).toBe("text");
    await click("Hide");
    await submit();
    expect(login).toHaveBeenCalledOnce();
    await click("Create an account");
    await fill("display-name", "Creator");
    await submit();
    expect(register).toHaveBeenCalledOnce();
    register.mockRejectedValue(new ApiError(409, "Already registered"));
    await submit();
    expect(container.textContent).toContain("Already registered");
    register.mockRejectedValue(new Error("unsafe"));
    await submit();
    expect(container.textContent).toContain("Something went wrong");
    await click("I already have an account");
    expect(container.querySelector("#display-name")).toBeNull();
  });
  it("shows Brief audience fields after signup with no workspace and restores selected workspaces", async () => {
    const list = vi.spyOn(api, "listWorkspaces").mockRejectedValue(new ApiError(401, "expired"));
    vi.spyOn(api, "login").mockResolvedValue({ userId: "user" });
    await mount(createElement(AuthWorkspace, null, "Studio content"));
    list.mockResolvedValue([]);
    await fill("email", "creator@example.com");
    await fill("password", "long-password-2026");
    await submit();
    expect([...container.querySelectorAll("form input,form select")].map((el) => el.id)).toEqual([
      "setup-niche",
      "setup-audience",
      "setup-language",
    ]);
    await act(async () => root.unmount());
    root = createRoot(container);
    const workspace = { id: "workspace", name: "Science", role: "OWNER" as const };
    list.mockResolvedValue([workspace]);
    localStorage.setItem("reelforge.activeWorkspace", "workspace");
    const logout = vi.spyOn(api, "logout").mockRejectedValue(new ApiError(503, "offline"));
    await mount(createElement(AuthWorkspace, null, "Studio content"));
    expect(container.textContent).toContain("Studio content");
    await click("Sign out");
    expect(container.textContent).toContain("Sign out did not complete");
    await click("Switch workspace");
    await click("Science");
    expect(container.textContent).toContain("Studio content");
    logout.mockResolvedValue({ ok: true });
    await click("Sign out");
    expect(container.querySelector("#email")).not.toBeNull();
  });
  it("retries workspace loading and offers new channel setup for existing members", async () => {
    const list = vi.spyOn(api, "listWorkspaces").mockRejectedValue(new ApiError(503, "offline"));
    await mount(createElement(AuthWorkspace, null, "Studio"));
    expect(container.textContent).toContain("offline");
    list.mockResolvedValue([{ id: "workspace", name: "Science", role: "OWNER" }]);
    await click("Retry workspace load");
    await click("Set up a new channel");
    expect([...container.querySelectorAll("form input,form select")].map((el) => el.id)).toEqual([
      "setup-niche",
      "setup-audience",
      "setup-language",
    ]);
  });
});
