// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import { AuthSession } from "./auth-session";
const workspace = { id: "workspace", name: "Science", role: "OWNER" as const };
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe("onboarding session generation fences", () => {
  it("loads an authorized saved workspace, notifies subscribers and supports switching", async () => {
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspace]);
    // A first visit with exactly one authorized workspace selects it directly.
    const session = new AuthSession(),
      listener = vi.fn();
    const off = session.subscribe(listener);
    await session.load();
    expect(session.snapshot()).toMatchObject({
      view: "studio",
      selected: workspace,
      booting: false,
    });
    session.switchWorkspace();
    expect(session.snapshot().selected).toBeNull();
    session.choose(workspace);
    expect(localStorage.getItem("reelforge.activeWorkspace")).toBe(workspace.id);
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    session.switchWorkspace();
    expect(listener).not.toHaveBeenCalled();
  });
  it("opens onboarding after signup and successful retries", async () => {
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
    const session = new AuthSession();
    await session.load();
    expect(session.snapshot().view).toBe("onboarding");
    await session.authenticated();
    await session.retry();
    expect(session.snapshot()).toMatchObject({ view: "onboarding", booting: false });
  });
  it.each([401, 403])("clears denied sessions (%s)", async (status) => {
    vi.spyOn(api, "listWorkspaces").mockRejectedValue(new ApiError(status, "denied"));
    const session = new AuthSession();
    await session.load();
    expect(session.snapshot().view).toBe("auth");
    expect(session.snapshot().booting).toBe(false);
    expect(Boolean(session.snapshot().sessionError)).toBe(status === 403);
  });
  it("retains useful failure messages without treating outages as logout", async () => {
    const list = vi.spyOn(api, "listWorkspaces").mockRejectedValue(new ApiError(503, "offline"));
    const session = new AuthSession();
    await session.load();
    expect(session.snapshot().sessionError).toBe("offline");
    await session.authenticated();
    expect(session.snapshot().sessionError).toContain("session is active");
    await session.retry();
    expect(session.snapshot().sessionError).toBe("offline");
    list.mockRejectedValue(new Error("unknown"));
    await session.load();
    expect(session.snapshot().sessionError).toBe("");
    await session.authenticated();
    await session.retry();
    expect(session.snapshot().sessionError).toContain("Something went wrong");
  });
  it("ignores stale loads and retries after a workspace switch", async () => {
    let resolve!: (value: (typeof workspace)[]) => void;
    vi.spyOn(api, "listWorkspaces").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const session = new AuthSession();
    const pending = session.load();
    session.choose(workspace);
    resolve([]);
    await pending;
    expect(session.snapshot().selected).toEqual(workspace);
    const retry = session.retry();
    session.switchWorkspace();
    resolve([]);
    await retry;
    expect(session.snapshot().selected).toBeNull();
    const auth = session.authenticated();
    session.choose(workspace);
    resolve([]);
    await auth;
    expect(session.snapshot().view).toBe("studio");
  });
  it("ignores stale failures rather than clearing a newer session", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(api, "listWorkspaces").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const session = new AuthSession();
    for (const operation of [session.load, session.retry, session.authenticated]) {
      const pending = operation();
      session.choose(workspace);
      reject(new ApiError(403, "stale"));
      await pending;
      expect(session.snapshot().selected).toEqual(workspace);
    }
  });
  it.each([200, 401, 503])("handles logout completion and failures (%s)", async (status) => {
    const logout = vi.spyOn(api, "logout");
    if (status === 200) logout.mockResolvedValue({ ok: true });
    else logout.mockRejectedValue(new ApiError(status, "failed"));
    const session = new AuthSession();
    session.choose(workspace);
    await session.logout();
    expect(session.snapshot().view).toBe(status === 503 ? "studio" : "auth");
    expect(Boolean(session.snapshot().logoutError)).toBe(status === 503);
  });
});
