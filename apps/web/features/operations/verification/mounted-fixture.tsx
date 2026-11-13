import { createRoot } from "react-dom/client";
import { OperationsScreen } from "../../../components/operations-screen";
import { WorkspaceProvider } from "../../../components/studio-workspace-context";
import type { WorkspaceRole } from "../../../lib/api";

const role = new URLSearchParams(location.search).get("role") as WorkspaceRole;
const calls: string[] = [];
Object.assign(window, { calls });
const now = "2026-11-13T00:00:00.000Z";
window.fetch = async (input, init): Promise<Response> => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  let result: unknown = [];
  if (url.endsWith("/orchestration/runs"))
    result = [
      {
        id: "run",
        state: "RUNNING",
        dispatchStatus: "DISPATCHED",
        budgetDecision: "ALLOWED",
        budgetReason: null,
        currentStepKey: "test",
        nextAction: null,
        pausedReason: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
        steps: [],
        jobs: [],
        events: [],
      },
    ];
  else if (url.endsWith("/notifications"))
    result = {
      items: [
        {
          id: "n",
          eventType: "test",
          title: "Notice",
          body: "Message",
          link: null,
          readAt: null,
          createdAt: now,
        },
      ],
      unreadCount: 1,
    };
  else if (url.endsWith("/notifications/preferences"))
    result = [
      {
        eventType: "test",
        sourceModule: "test",
        description: "Test",
        audience: "all",
        inApp: true,
        email: false,
        isDefault: true,
      },
    ];
  else if (url.endsWith("/usage/summary"))
    result = {
      period: "MONTH",
      periodKey: "2026-11",
      periodStart: now,
      periodEnd: now,
      timezone: "UTC",
      totals: {
        currencies: [],
        unknownCostRequests: 0,
        unpricedRequests: 0,
        notDispatchedRequests: 0,
      },
    };
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
createRoot(document.getElementById("root")!).render(
  <WorkspaceProvider workspace={{ id: "workspace", name: "Test", role }}>
    <OperationsScreen />
  </WorkspaceProvider>,
);
