import {
  RunDetailViewSchema,
  RunSummariesSchema,
  RunAutonomyStatusSchema,
  RunUsageSchema,
} from "../../../../packages/contracts/src/run-experience";
import { ensureCsrfToken, withCsrf } from "../../lib/csrf";

export async function runRequest(
  path: string,
  workspaceId: string,
  body?: unknown,
): Promise<unknown> {
  if (body !== undefined) await ensureCsrfToken();
  const scopedPath = path.startsWith("run-experience")
    ? `workspaces/${encodeURIComponent(workspaceId)}/${path}`
    : path;
  const response = await fetch(
    `/api/v1/${scopedPath}${scopedPath.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`,
    withCsrf({
      credentials: "include",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json().catch(() => null);
}
export const runClient = {
  list: async (workspaceId: string): Promise<ReturnType<typeof RunSummariesSchema.parse>> =>
    RunSummariesSchema.parse(await runRequest("run-experience", workspaceId)),
  detail: async (
    workspaceId: string,
    id: string,
  ): Promise<ReturnType<typeof RunDetailViewSchema.parse>> =>
    RunDetailViewSchema.parse(await runRequest(`runs/${id}`, workspaceId)),
  status: async (
    workspaceId: string,
    id: string,
  ): Promise<ReturnType<typeof RunAutonomyStatusSchema.parse>> =>
    RunAutonomyStatusSchema.parse(await runRequest(`run-experience/${id}/autonomy`, workspaceId)),
  usage: async (workspaceId: string): Promise<ReturnType<typeof RunUsageSchema.parse>> =>
    RunUsageSchema.parse(await runRequest("run-experience/usage", workspaceId)),
};

const eventTypes = [
  "created",
  "transition",
  "stage_started",
  "stage_completed",
  "stage_approved",
  "step_started",
  "step_completed",
  "shot_started",
  "shot_completed",
  "approved",
  "auto_approved",
  "human_rejected",
  "autonomy_selected",
  "autonomy_fallback",
  "reshoot_requested",
  "emergency_stop",
  "dispatch_reserved",
  "dispatch_released",
  "provider_dispatch",
  "provider_receipt",
  "billing_reconciled",
  "reconcile_required",
  "step_abandoned",
  "resumed",
  "publish_dry_run",
  "media_completed",
  "media_intent",
  "provider_submitted",
  "budget_estimated",
  "fallback",
  "reedit_requested",
  "critic_packaged",
  "critic_assembly_invalidated",
];
/** V3 emits named SSE events. Native EventSource reconnects using Last-Event-ID. */
export function watchRun(
  workspaceId: string,
  id: string,
  update: () => void,
  connection: (state: string) => void,
): () => void {
  const source = new EventSource(
    `/api/v1/runs/${id}/events?workspaceId=${encodeURIComponent(workspaceId)}`,
    { withCredentials: true },
  );
  let sequence = 0;
  const receive = (event: MessageEvent<string>): void => {
    const next = Number(event.lastEventId);
    if (!Number.isSafeInteger(next) || next <= sequence) return;
    sequence = next;
    update();
  };
  for (const type of eventTypes) source.addEventListener(type, receive as EventListener);
  source.onopen = (): void => connection("Live");
  source.onerror = (): void => connection("Reconnecting…");
  return (): void => source.close();
}
