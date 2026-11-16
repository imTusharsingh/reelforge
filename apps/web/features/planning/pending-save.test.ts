import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanningClient, pendingSave, clearPendingSave, draftFromIdea } from "./model";
import { idea, script } from "./verification/fixtures";
const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });
const client = (): PlanningClient =>
  new PlanningClient(idea.workspaceId, "EDITOR", new AbortController().signal);
afterEach(() => {
  clearPendingSave(idea.workspaceId);
  vi.unstubAllGlobals();
});
describe("R1 resource-specific interrupted-save reconciliation", () => {
  function storage(path = "ideas/idea-one"): Map<string, string> {
    const values = new Map([["reelforge.planning.pending:workspace-one", path]]);
    vi.stubGlobal("window", {});
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
      removeItem: (key: string): void => {
        values.delete(key);
      },
    });
    return values;
  }
  it("does not accept a forged confirmation or an unrelated successful read", async () => {
    storage();
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ items: [script], nextPage: null })),
    );
    await api.scripts();
    expect(() => api.acknowledgePendingSave({ resource: "ideas", snapshot: [idea] })).toThrow(
      "Fetch and compare",
    );
    expect(pendingSave(idea.workspaceId)).toBe("ideas/idea-one");
  });
  it.each([403, 404, 500])(
    "allows explicit retry after a failed background read (%s)",
    async (status) => {
      storage();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response({ message: "Read failed" }, status)),
      );
      await expect(client().reconcilePendingSave()).rejects.toThrow();
      expect(pendingSave(idea.workspaceId)).toBe("ideas/idea-one");
      await expect(client().editIdea(idea, draftFromIdea(idea))).rejects.toMatchObject({
        status,
      });
    },
  );
  it("validates scoped saved data and only clears after explicit comparison", async () => {
    storage();
    const api = client();
    const fetch = vi.fn().mockResolvedValue(response([idea]));
    vi.stubGlobal("fetch", fetch);
    const result = await api.reconcilePendingSave();
    expect(result.snapshot).toMatchObject({
      id: idea.id,
      title: idea.title,
      updatedAt: idea.updatedAt,
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("ideas?includeArchived=true");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", credentials: "include" });
    expect(pendingSave(idea.workspaceId)).toBeTruthy();
    api.acknowledgePendingSave(result);
    expect(pendingSave(idea.workspaceId)).toBeNull();
    expect(() => api.acknowledgePendingSave(result)).toThrow();
  });
  it("fetches a script for a lost revision acknowledgement rather than unrelated history", async () => {
    storage("scripts/script-one/revisions");
    const api = client();
    const fetch = vi.fn().mockResolvedValue(
      response({
        ...script,
        revisions: [{ ...script.revisions[0], promptText: "private-dispatched-prompt" }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await api.reconcilePendingSave();
    expect(result.snapshot).toMatchObject({
      id: script.id,
      currentRevision: script.currentRevision,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/workspace-one/scripts/script-one");
    expect(JSON.stringify(result.snapshot)).not.toContain("private-dispatched-prompt");
    api.acknowledgePendingSave(result);
    expect(pendingSave(idea.workspaceId)).toBeNull();
  });
  it("rejects malformed/foreign successful responses and missing affected ideas", async () => {
    storage();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response([{ ...idea, workspaceId: "foreign" }]))
        .mockResolvedValueOnce(response([])),
    );
    await expect(client().reconcilePendingSave()).rejects.toThrow("out-of-workspace");
    await expect(client().reconcilePendingSave()).rejects.toMatchObject({ status: 404 });
    expect(pendingSave(idea.workspaceId)).toBeTruthy();
  });
  it("reconciles a lost create through the unfiltered archive-inclusive collection", async () => {
    storage("ideas");
    const api = client();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([idea])));
    const result = await api.reconcilePendingSave();
    expect(result.snapshot).toMatchObject([{ id: idea.id, title: idea.title }]);
    expect(result.resource).toContain("no confirmed ID");
    api.acknowledgePendingSave(result);
    expect(pendingSave(idea.workspaceId)).toBeNull();
  });
  it("invalidates a comparison if another pending operation replaces it, even at the same path", async () => {
    const values = storage();
    const api = client();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([idea])));
    const result = await api.reconcilePendingSave();
    values.set(
      "reelforge.planning.pending:workspace-one",
      JSON.stringify({ path: "ideas/idea-one", nonce: "new-operation" }),
    );
    expect(() => api.acknowledgePendingSave(result)).toThrow();
    expect(pendingSave(idea.workspaceId)).toBeTruthy();
  });
  it("does not reconcile while a known write is still in flight", async () => {
    storage();
    clearPendingSave(idea.workspaceId);
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const api = client();
    const writing = api.createIdea(draftFromIdea(idea));
    await expect(api.reconcilePendingSave()).rejects.toThrow("active save");
    finish!(response(idea));
    await writing;
    expect(pendingSave(idea.workspaceId)).toBeNull();
  });
});
