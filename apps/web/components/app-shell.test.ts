// @vitest-environment jsdom
import { act, createElement, type JSX, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({ usePathname: (): string => "/publishing" }));
vi.mock("./studio-link", () => ({
  StudioLink: ({
    children,
    onNavigate,
    ...props
  }: {
    children: ReactNode;
    onNavigate?: () => void;
    href: string;
  }): JSX.Element => createElement("a", { ...props, onClick: onNavigate }, children),
}));

describe("creator studio shell accessibility", () => {
  it("offers a named workspace switch, mobile menu, skip link and current navigation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSwitch = vi.fn();
    const onSignOut = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
    try {
      await act(async () =>
        root.render(
          createElement(AppShell, {
            children: "Studio content",
            workspaceName: "Long workspace name for narrow screens",
            onWorkspaceSwitch: onSwitch,
            onSignOut,
          }),
        ),
      );
      const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!;
      const dialog = host.querySelector("dialog")!;
      const open = vi.fn(() => dialog.setAttribute("open", ""));
      const close = vi.fn(() => {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close", { bubbles: true }));
      });
      Object.defineProperties(dialog, {
        showModal: { value: open },
        close: { value: close },
      });
      expect(host.querySelector('a[href="#main-content"]')?.textContent).toContain("Skip");
      expect(host.querySelector('main[id="main-content"]')?.textContent).toContain(
        "Studio content",
      );
      expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe(
        "/publishing",
      );
      expect(menu.getAttribute("aria-controls")).toBe(dialog.id);
      const workspace = host.querySelector<HTMLButtonElement>(".rf-workspace-switch")!;
      expect(workspace.getAttribute("aria-label")).toBe(
        "Switch workspace: Long workspace name for narrow screens",
      );
      await act(async () => workspace.click());
      expect(onSwitch).toHaveBeenCalledOnce();
      await act(async () => menu.click());
      expect(open).toHaveBeenCalledOnce();
      const signOut = dialog.querySelector<HTMLButtonElement>(".rf-nav-footer button")!;
      await act(async () => signOut.click());
      expect(close).not.toHaveBeenCalled();
      await act(async () => signOut.click());
      expect(close).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(menu);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
