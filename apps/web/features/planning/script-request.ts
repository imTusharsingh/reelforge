const memory = new Map<string, string>();
/** Retained across background acknowledgement; only successful script response clears it. */
export async function scriptRequestIdentity(
  workspaceId: string,
  input: unknown,
): Promise<{ key: string; correlationId: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = `reelforge.planning.script:${workspaceId}:${fingerprint}`;
  let saved = memory.get(key);
  try {
    saved = sessionStorage.getItem(key) ?? saved;
  } catch {
    /* Memory preserves the identity if storage is unavailable. */
  }
  if (saved && !/^[a-f0-9-]{36}$/i.test(saved))
    throw new Error(
      "Interrupted script identity is invalid; refresh saved scripts before continuing.",
    );
  const correlationId = saved ?? crypto.randomUUID();
  memory.set(key, correlationId);
  try {
    sessionStorage.setItem(key, correlationId);
  } catch {
    /* No prompts, credentials or request bodies are stored. */
  }
  return { key, correlationId };
}
export function finishScriptRequest(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Memory remains consistent. */
  }
}
