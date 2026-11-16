import { afterEach, expect, it, vi } from "vitest";
import { PlanningClient, pendingSave } from "./model";
import { script } from "./verification/fixtures";

const input = {
  approvedIdeaSnapshotId: "approved",
  approvedIdeaChecksum: "checksum",
  configSnapshotId: "config",
  promptSnapshotId: "prompt",
  prompt: "Unique paid-retry regression",
};
afterEach(() => {
  vi.unstubAllGlobals();
});
it("reuses the paid identity across background reconciliation and a page reload", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const dispatched = new Set<string>();
  const sent: string[] = [];
  let loseAcknowledgement = true;
  const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method === "GET")
      return new Response(JSON.stringify({ items: [script], nextPage: null }));
    const body = JSON.parse(String(options.body)) as { correlationId: string };
    sent.push(body.correlationId);
    dispatched.add(body.correlationId); // Server's durable idempotency boundary.
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("Response interrupted after commit");
    }
    return new Response(JSON.stringify(script));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new PlanningClient(script.workspaceId, "EDITOR", new AbortController().signal);
  await expect(client.generateScript(input)).rejects.toMatchObject({ uncertain: true });
  expect(pendingSave(script.workspaceId)).toBe("scripts");
  client.acknowledgePendingSave(await client.reconcilePendingSave());
  expect(pendingSave(script.workspaceId)).toBeNull();
  vi.resetModules();
  const { PlanningClient: ReloadedClient } = await import("./model");
  const reloaded = new ReloadedClient(script.workspaceId, "EDITOR", new AbortController().signal);
  await expect(reloaded.generateScript(input)).resolves.toMatchObject({ id: script.id });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(dispatched.size).toBe(1);
  expect([...storage.values()].join(" ")).not.toContain(input.prompt);
});
