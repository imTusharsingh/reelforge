// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../../components/studio-workspace-context";
import { NotificationProvider } from "../../components/ui/notifications";
import { Accounts } from "./accounts";
import { accountId, accounts, workspaceId } from "./fixtures.fixture";
import { PublishingScope } from "./session";

vi.mock("next/navigation", () => ({ usePathname: (): string => "/publishing/accounts" }));

let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(name: string): Promise<void> {
  const button = Array.from(host.querySelectorAll("button")).find(
    (row) => row.textContent === name,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

async function mount(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NotificationProvider, {
        children: createElement(WorkspaceProvider, {
          workspace: { id: workspaceId, name: "Studio", role: "OWNER" },
          children: createElement(PublishingScope, { children: createElement(Accounts) }),
        }),
      }),
    ),
  );
}

it.each(["stale", "reconnected"] as const)(
  "retries only the reads after a confirmed disconnect and handles a %s response",
  async (reloaded) => {
    const account = accounts[0]!;
    const refreshing = Promise.withResolvers<Response>();
    let reads = 0;
    let writes = 0;
    const fetcher = vi.fn(async (url: string, request: RequestInit): Promise<Response> => {
      if (url.endsWith(`/social-accounts/${accountId}/revoke`) && request.method === "POST") {
        writes++;
        return Response.json({ ...account, status: "REVOKED", health: "AUTH_REQUIRED" });
      }
      if (url.endsWith("/social-accounts")) {
        reads++;
        if (reads === 2) return refreshing.promise;
        if (reads === 3 && reloaded === "reconnected")
          return Response.json([{ ...account, connectedAt: "2026-11-14T10:00:00.000Z" }]);
        // A stale CONNECTED row must not reappear after a confirmed revoke.
        return Response.json(accounts);
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetcher);
    await mount();
    expect(host.textContent).toContain("Fixture YouTube");
    await click("Disconnect");
    expect(host.textContent).not.toContain("Fixture YouTube");
    await act(async () =>
      refreshing.resolve(Response.json({ message: "offline" }, { status: 503 })),
    );
    expect(host.textContent).toContain("Account disconnected.");
    expect(host.textContent).toContain("Account lists could not be refreshed.");
    expect(host.textContent).not.toContain("Account action failed");

    await click("Retry list refresh");
    expect(writes).toBe(1);
    expect(reads).toBe(3);
    expect(host.textContent).toContain("Account lists refreshed.");
    if (reloaded === "reconnected") expect(host.textContent).toContain("Fixture YouTube");
    else expect(host.textContent).not.toContain("Fixture YouTube");
  },
);

it("does not hide or report a disconnect when the mutation has not been confirmed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith("/revoke")) return Response.json(accounts[0]);
      if (url.endsWith("/social-accounts")) return Response.json(accounts);
      return Response.json([]);
    }),
  );
  await mount();
  await click("Disconnect");
  expect(host.textContent).toContain("Fixture YouTube");
  expect(host.textContent).toContain("Account action failed");
  expect(host.textContent).toContain("Previous account action may still be pending");
  expect(host.textContent).not.toContain("Account disconnected.");
});
