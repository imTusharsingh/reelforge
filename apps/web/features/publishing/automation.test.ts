// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCalendar } from "./automation-calendar";
import { WorkspaceProvider } from "../../components/studio-workspace-context";
import { NotificationProvider } from "../../components/ui/notifications";
import { AutomationComposer, PublishingComposer } from "./automation-composer";
import { autoSlots, automationRequest } from "./automation-api";
import { secondWorkspaceId, workspaceId } from "./fixtures.fixture";
vi.mock("next/navigation", () => ({
  usePathname: (): string => window.location.pathname,
  useSearchParams: (): URLSearchParams => new URLSearchParams(window.location.search),
}));
vi.mock("../../components/studio-link", () => ({
  StudioLink: ({ href, children }: { href: string; children: ReactNode }): ReactNode =>
    createElement("a", { href }, children),
}));
const uuid = "11111111-1111-4111-8111-111111111111";
const slot = {
  id: uuid,
  runId: uuid,
  channelId: uuid,
  scheduledAt: "2027-03-14T07:00:00.000Z",
  timezone: "America/New_York",
  status: "NEEDS_HUMAN",
  scheduledPostId: uuid,
  lastError: "RECONNECT_YOUTUBE",
  package: {
    renderJobId: uuid,
    qualityReviewRunId: uuid,
    title: "Science",
    description: "Original story",
    tags: ["science"],
    coverFrame: "cover.png",
    containsSyntheticMedia: true,
  },
};
const secondSlot = {
  ...slot,
  id: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  package: { ...slot.package, title: "History" },
};
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
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

async function navigateTo(id: string, workspace = workspaceId): Promise<void> {
  window.history.replaceState(null, "", `/publishing/new?autoSlot=${id}`);
  await renderInWorkspace(createElement(PublishingComposer), workspace);
}

async function renderInWorkspace(children: ReactNode, workspace = workspaceId): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NotificationProvider, {
        children: createElement(WorkspaceProvider, {
          workspace: { id: workspace, name: "Studio", role: "OWNER" },
          children,
        }),
      }),
    ),
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((row) => row.textContent === label);
}

const reconcile = "Reconcile after reconnect";
const reloadDetails = "Reload publishing details";
const getTitle = (): string | undefined => host.querySelector("input")?.value;

describe("V9 automatic calendar and prefilled composer with fake HTTP", () => {
  it("shows the channel-zone slot and packaged title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([slot])),
    );
    await renderInWorkspace(createElement(AutomationCalendar));
    expect(host.querySelector("h1")?.textContent).toBe("Publishing schedule");
    expect(host.querySelector("time")?.dateTime).toBe(slot.scheduledAt);
    expect(host.textContent).toContain("Science");
    expect(host.textContent).toContain("America/New_York");
    expect(host.querySelector(`a[href="/publishing/new?autoSlot=${uuid}"]`)).not.toBeNull();
  });
  it("prefills metadata and offers existing OAuth reconnect with a fenced reconciliation action", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(slot));
    vi.stubGlobal("fetch", fetcher);
    await renderInWorkspace(createElement(AutomationComposer, { id: uuid }));
    expect(host.querySelector("input")?.value).toBe("Science");
    expect(host.querySelector("textarea")?.value).toBe("Original story");
    expect(host.querySelector('a[href="/publishing/accounts"]')).not.toBeNull();
    await act(async () => button(reconcile)!.click());
    expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith(`/${uuid}/retry`))).toBe(
      true,
    );
  });
  it("validates server output and reports HTTP failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(autoSlots("workspace")).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(automationRequest("workspace")).rejects.toThrow("403");
  });
});

it.each(["slow", "failed", "wrong-slot"] as const)(
  "does not display or allow reconciliation of A when loading B is %s",
  async (mode) => {
    const loading = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith(secondSlot.id) ? loading.promise : Response.json(slot),
    );
    vi.stubGlobal("fetch", fetcher);
    await navigateTo(slot.id);
    expect(getTitle()).toBe("Science");
    expect(button(reconcile)).toBeDefined();

    await navigateTo(secondSlot.id);
    expect(getTitle()).toBeUndefined();
    expect(button(reconcile)).toBeUndefined();
    expect(host.textContent).toContain("Loading packaged metadata");
    await act(async () =>
      loading.resolve(
        mode === "failed"
          ? new Response(null, { status: 503 })
          : Response.json(mode === "wrong-slot" ? slot : secondSlot),
      ),
    );

    expect(getTitle()).toBe(mode === "slow" ? "History" : undefined);
    if (mode !== "slow") {
      expect(host.textContent).toContain("Publishing details unavailable");
      expect(button(reconcile)).toBeUndefined();
      expect(button(reloadDetails)).toBeDefined();
    }
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  },
);

it("does not let a late GET for A overwrite B's metadata", async () => {
  const loading = Promise.withResolvers<Response>();
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith(slot.id) ? loading.promise : Response.json(secondSlot),
  );
  vi.stubGlobal("fetch", fetcher);
  await navigateTo(slot.id);
  await navigateTo(secondSlot.id);
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(getTitle()).toBe("History");
  await act(async () => loading.resolve(Response.json(slot)));
  expect(getTitle()).toBe("History");
});

it.each(["POST success pending", "POST failure pending", "refresh pending"] as const)(
  "fences A with %s during A → B and reconciles B's run next",
  async (phase) => {
    const late = Promise.withResolvers<Response>();
    const actions: string[] = [];
    let aReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/csrf")) return Response.json({});
      if (init?.method === "POST") {
        actions.push(url);
        return url.endsWith(`/${slot.runId}/retry`) && phase !== "refresh pending"
          ? late.promise
          : Response.json({});
      }
      if (url.endsWith(slot.id)) {
        aReads++;
        return aReads === 2 ? late.promise : Response.json(slot);
      }
      return Response.json(secondSlot);
    });
    vi.stubGlobal("fetch", fetcher);
    await navigateTo(slot.id);
    await act(async () => button(reconcile)!.click());
    expect(actions).toHaveLength(1);
    expect(aReads).toBe(phase !== "refresh pending" ? 1 : 2);

    await navigateTo(secondSlot.id);
    expect(getTitle()).toBe("History");
    expect(button(reconcile)?.disabled).toBe(false);
    await act(async () =>
      late.resolve(
        phase === "POST failure pending"
          ? new Response(null, { status: 503 })
          : Response.json(slot),
      ),
    );
    expect(getTitle()).toBe("History");
    expect(host.textContent).not.toContain("Publishing status refreshed.");
    expect(host.textContent).not.toContain("Reconciliation could not be confirmed");
    expect(aReads).toBe(phase !== "refresh pending" ? 1 : 2);

    await act(async () => button(reconcile)!.click());
    expect(actions).toEqual([
      `/api/v1/workspaces/${workspaceId}/publishing/automation/${slot.runId}/retry`,
      `/api/v1/workspaces/${workspaceId}/publishing/automation/${secondSlot.runId}/retry`,
    ]);
    expect(host.textContent).toContain("Publishing status refreshed.");
  },
);

it("cancels before POST if the workspace changes during CSRF setup", async () => {
  const csrf = Promise.withResolvers<Response>();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/csrf")) return csrf.promise;
    if (url.includes(secondWorkspaceId)) {
      return Response.json({ ...slot, package: { ...slot.package, title: "Other workspace" } });
    }
    return Response.json(slot);
  });
  vi.stubGlobal("fetch", fetcher);
  await navigateTo(slot.id);
  await act(async () => button(reconcile)!.click());
  await navigateTo(slot.id, secondWorkspaceId);
  await act(async () => csrf.resolve(Response.json({})));
  expect(getTitle()).toBe("Other workspace");
  expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
});

it("retries only the read if the details refresh fails after reconciliation", async () => {
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === "POST" || String(input).endsWith("/auth/csrf")) return Response.json({});
    reads++;
    if (reads === 2) return new Response(null, { status: 503 });
    return Response.json(reads === 1 ? slot : { ...slot, lastError: null, status: "WAITING" });
  });
  vi.stubGlobal("fetch", fetcher);
  await navigateTo(slot.id);
  await act(async () => button(reconcile)!.click());
  expect(button(reconcile)).toBeUndefined();
  expect(host.textContent).toContain("Publishing details unavailable");
  await act(async () => button(reloadDetails)!.click());
  expect(host.textContent).toContain("WAITING");
  expect(button(reconcile)).toBeUndefined();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
