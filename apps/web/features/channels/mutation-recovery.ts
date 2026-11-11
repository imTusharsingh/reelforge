const prefix = "reelforge.m23.pending:";
export function pendingSave(workspaceId: string): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(prefix + workspaceId);
  } catch {
    return null;
  }
}
export function markPendingSave(workspaceId: string, path: string): void {
  try {
    if (typeof window !== "undefined") window.sessionStorage.setItem(prefix + workspaceId, path);
  } catch {
    /* Recovery still refreshes in-memory resources when storage is unavailable. */
  }
}
export function clearPendingSave(workspaceId: string): void {
  try {
    if (typeof window !== "undefined") window.sessionStorage.removeItem(prefix + workspaceId);
  } catch {
    /* No credential or request body is persisted. */
  }
}
