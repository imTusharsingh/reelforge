import {
  AutoSlotViewSchema,
  AutoSlotViewsSchema,
  type AutoSlotView,
} from "../../../../packages/contracts/src/publishing-automation";
import { withCsrf, ensureCsrfToken } from "../../lib/csrf";
export async function automationRequest(
  workspaceId: string,
  suffix = "",
  retry = false,
): Promise<unknown> {
  if (retry) await ensureCsrfToken();
  const response = await fetch(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/publishing/automation${suffix}`,
    withCsrf({ credentials: "include", ...(retry ? { method: "POST" } : {}) }),
  );
  if (!response.ok) throw new Error(`Publishing automation request failed (${response.status})`);
  return response.json().catch(() => null);
}
export async function autoSlots(workspaceId: string): Promise<AutoSlotView[]> {
  return AutoSlotViewsSchema.parse(await automationRequest(workspaceId));
}
export async function autoSlot(workspaceId: string, id: string): Promise<AutoSlotView> {
  return AutoSlotViewSchema.parse(
    await automationRequest(workspaceId, `/${encodeURIComponent(id)}`),
  );
}
