import { createRoot } from "react-dom/client";
import { WorkspaceProvider } from "../../../components/studio-workspace-context";
import { InsightsScreen } from "../insights-screen";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") ?? "complete";
const role = query.get("role") === "VIEWER" ? "VIEWER" : "EDITOR";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const calls: Array<{ path: string; method: string }> = [];
Object.assign(window, { m28Fixture: { calls } });
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });
const snapshot = (
  id: string,
  key: string,
  value: number | null,
  remoteEntityId: string | null,
  completeness = "COMPLETE",
  availability = "AVAILABLE",
): Record<string, unknown> => ({
  id,
  key,
  value,
  unit: "COUNT",
  entityGranularity: remoteEntityId === null ? "CHANNEL" : "VIDEO",
  remoteEntityId,
  periodStart: "2026-11-01",
  periodEnd: "2026-11-01",
  collectedAt: "2026-11-02T00:00:00.000Z",
  sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
  completeness,
  availability,
  unavailableReason: availability === "AVAILABLE" ? null : "PROVIDER_UNAVAILABLE",
});

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.origin);
  const method = init?.method ?? "GET";
  calls.push({ path: `${url.pathname}${url.search}`, method });
  if (url.pathname.endsWith("/channels")) return json([{ id: channelId, name: "Fixture channel" }]);
  if (url.pathname.endsWith("/social-accounts"))
    return json([
      { id: accountId, channelId, platform: "YOUTUBE", displayName: "Fixture YouTube" },
      {
        id: "44444444-4444-4444-8444-444444444444",
        channelId,
        platform: "INSTAGRAM",
        displayName: "Fixture Instagram",
      },
    ]);
  if (url.pathname.endsWith("/metrics/snapshots")) {
    if (mode === "missing") return json([]);
    const video = url.searchParams.get("granularity") === "VIDEO";
    return json(
      video
        ? [
            snapshot("55555555-5555-4555-8555-555555555551", "views", 20, "video-low"),
            snapshot("55555555-5555-4555-8555-555555555552", "views", 80, "video-top"),
            snapshot("55555555-5555-4555-8555-555555555553", "likes", 8, "video-top", "PARTIAL"),
          ]
        : [
            snapshot(
              "55555555-5555-4555-8555-555555555554",
              "views",
              mode === "unavailable" ? null : 100,
              null,
              mode === "partial" ? "PARTIAL" : "COMPLETE",
              mode === "unavailable" ? "UNAVAILABLE" : "AVAILABLE",
            ),
          ],
    );
  }
  if (url.pathname.endsWith("/performance-intelligence/reports"))
    return json([
      {
        id: "66666666-6666-4666-8666-666666666666",
        status: mode === "insufficient" ? "INSUFFICIENT_DATA" : "GENERATED",
        aiStatus: "NOT_CONFIGURED",
        dimensions: [
          { dimension: "TOPIC", status: mode === "insufficient" ? "INSUFFICIENT_DATA" : "OK" },
        ],
      },
    ]);
  if (url.pathname.endsWith("/performance-intelligence/recommendations"))
    return json([
      {
        id: "77777777-7777-4777-8777-777777777777",
        rank: 1,
        action: "Keep the strongest hook",
        rationale: "Verified evidence",
        confidence: "MEDIUM",
        limitations: ["Small sample"],
        evidenceSnapshotIds: ["55555555-5555-4555-8555-555555555552"],
        status: "PROPOSED",
      },
    ]);
  if (url.pathname.endsWith("/publishing/published-records"))
    return json([
      { platformPostId: "video-top", publishedAt: "2026-11-01T12:00:00.000Z" },
      { platformPostId: "video-low", publishedAt: "2026-10-30T12:00:00.000Z" },
    ]);
  if (method === "POST" && url.pathname.endsWith("/analytics/collection-jobs"))
    return json({ id: "88888888-8888-4888-8888-888888888888" });
  if (method === "POST" && url.pathname.endsWith("/run")) return json({ status: "SUCCEEDED" });
  if (method === "POST") return json({});
  return json({ message: "Not found" }, 404);
};

createRoot(document.getElementById("root")!).render(
  <WorkspaceProvider workspace={{ id: workspaceId, name: "Fixture", role }}>
    <InsightsScreen />
  </WorkspaceProvider>,
);
