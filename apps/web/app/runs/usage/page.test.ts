// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import UsagePage from "./page";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const euroChannelId = "22222222-2222-4222-8222-222222222222";
const usdChannelId = "33333333-3333-4333-8333-333333333333";

vi.mock("../../../components/auth-workspace", () => ({
  AuthWorkspace: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock("../../../components/studio-workspace-context", () => ({
  useActiveWorkspace: (): { id: string; role: "OWNER" } => ({ id: workspaceId, role: "OWNER" }),
}));
afterEach(() => vi.unstubAllGlobals());

it("explains incompatible currency without formatting it as a dollar cap", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string): Promise<Response> => {
      if (!url.includes("/usage/budgets?")) return Response.json([]);
      const euro = {
        channelId: euroChannelId,
        name: "Euro channel",
        incompatibleCurrencies: ["EUR"],
      };
      const usd = {
        channelId: usdChannelId,
        name: "Dollar channel",
        dailyLimitMinor: 75,
        monthlyLimitMinor: 200,
      };
      return Response.json([{ effectiveBriefCaps: [euro, usd] }, { effectiveBriefCaps: [euro] }]);
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UsagePage)));
    const rows = [...host.querySelectorAll("p")].map((node) => node.textContent);
    expect(rows.filter((row) => row?.includes("Euro channel"))).toEqual([
      "Euro channel · Paid runs require USD budgets. Incompatible currency: EUR",
    ]);
    expect(rows).toContain("Dollar channel · Effective daily cap $0.75 · Monthly cap $2.00");
    expect(host.textContent).not.toContain("Channel caps could not be loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
