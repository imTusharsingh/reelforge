import { record, string } from "./model-parse";
const pendingMemory = new Map<string, string>();
const pendingKey = (workspaceId: string): string => `reelforge.planning.pending:${workspaceId}`;
export function readPendingMarker(workspaceId: string): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : (sessionStorage.getItem(pendingKey(workspaceId)) ?? pendingMemory.get(workspaceId) ?? null);
  } catch {
    return pendingMemory.get(workspaceId) ?? null;
  }
}
export function pendingSave(workspaceId: string): string | null {
  const marker = readPendingMarker(workspaceId);
  if (!marker) return null;
  try {
    const parsed: unknown = JSON.parse(marker);
    return record(parsed) && string(parsed.path) ? parsed.path : marker;
  } catch {
    return marker;
  }
}
export function markPendingSave(workspaceId: string, path: string): void {
  const marker = JSON.stringify({ path, nonce: crypto.randomUUID() });
  if (typeof window !== "undefined") pendingMemory.set(workspaceId, marker);
  try {
    if (typeof window !== "undefined") sessionStorage.setItem(pendingKey(workspaceId), marker);
  } catch {
    /* Requests are never automatically replayed. */
  }
}
export function clearPendingSave(workspaceId: string): void {
  pendingMemory.delete(workspaceId);
  try {
    if (typeof window !== "undefined") sessionStorage.removeItem(pendingKey(workspaceId));
  } catch {
    /* No request bodies or credentials are stored. */
  }
}
