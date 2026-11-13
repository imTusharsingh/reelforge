import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlanningClient,
  canWrite,
  draftFromIdea,
  ideaPayload,
  mergeRevision,
  moveScene,
  nextStatus,
  normalizeSceneTimings,
  parseDocument,
  parseIdea,
  parsePage,
  parseRevision,
  parseScript,
  patchScene,
  validateDocument,
  pendingSave,
  clearPendingSave,
} from "./model";
import { document, idea, script } from "./verification/fixtures";
const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });
const client = (role: "OWNER" | "EDITOR" | "VIEWER" = "EDITOR", denied = vi.fn()): PlanningClient =>
  new PlanningClient(idea.workspaceId, role, new AbortController().signal, denied);
afterEach(() => {
  clearPendingSave(idea.workspaceId);
  vi.unstubAllGlobals();
});
describe("M24 planning contracts and safe targeted revisions", () => {
  it("accepts only scoped persisted ideas and scripts", () => {
    expect(parseIdea(idea, idea.workspaceId)).toEqual(idea);
    expect(() => parseIdea(idea, "other")).toThrow();
    expect(() => parseScript(script, "other", script.id)).toThrow();
    expect(() =>
      parseScript({ ...script, currentRevision: 2 }, idea.workspaceId, script.id),
    ).toThrow();
    expect(() => parseIdea({ ...idea, status: "INVENTED" }, idea.workspaceId)).toThrow();
  });
  it("validates real revision pages instead of reconstructing history", () => {
    expect(parseRevision(script.revisions[0]).document).toEqual(document);
    expect(parsePage({ items: script.revisions, nextPage: 2 }, parseRevision, 1).nextPage).toBe(2);
    expect(() => parsePage({ items: [], nextPage: 1 }, parseRevision, 1)).toThrow();
    expect(() => parseDocument({ ...document, scenes: [] })).toThrow();
  });
  it("retains all idea brief fields and requires a channel or series", () => {
    expect(ideaPayload(draftFromIdea(idea))).toMatchObject({
      title: idea.title,
      references: idea.references,
      channelId: idea.channelId,
    });
    expect(
      ideaPayload({
        ...draftFromIdea(idea),
        references: [" https://example.com/one ", "", "https://example.com/two"],
      }).references,
    ).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(() => ideaPayload({ ...draftFromIdea(idea), channelId: "", seriesId: "" })).toThrow();
  });
  it("uses only existing status transitions and verified roles", () => {
    expect(nextStatus("DRAFT")).toEqual(["BACKLOG", "APPROVED", "REJECTED"]);
    expect(nextStatus("APPROVED")).toEqual(["SCHEDULED", "REJECTED"]);
    expect(nextStatus("REJECTED")).toEqual(["BACKLOG"]);
    expect(canWrite("OWNER")).toBe(true);
    expect(canWrite("EDITOR")).toBe(true);
    expect(canWrite("VIEWER")).toBe(false);
  });
  it("targeted text changes preserve all unrelated scenes and timing", () => {
    const patched = patchScene(document, "scene-one", { dialogue: "Revised", id: "forged" });
    expect(patched.scenes[0]?.id).toBe("scene-one");
    expect(patched.scenes[1]).toBe(document.scenes[1]);
    expect(document.scenes[0]?.dialogue).toBe("Begin here");
  });
  it("reorders by stable ID and explicitly recomputes scene starts", () => {
    const moved = moveScene(document, "scene-two", -1);
    expect(moved.scenes.map((s) => [s.id, s.startSeconds])).toEqual([
      ["scene-two", 0],
      ["scene-one", 10],
    ]);
    expect(moveScene(document, "missing", 1)).toBe(document);
    expect(normalizeSceneTimings(document.scenes)[1]?.startSeconds).toBe(10);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid scene duration %s", (durationSeconds) => {
    expect(validateDocument(patchScene(document, "scene-one", { durationSeconds }))).toBeTruthy();
  });
  it("validates total duration, claims, duplicate IDs and persisted character references", () => {
    expect(validateDocument(document)).toBeNull();
    expect(
      validateDocument({
        ...document,
        metadata: { ...document.metadata, targetDurationSeconds: NaN },
      }),
    ).toBeTruthy();
    expect(
      validateDocument({
        ...document,
        claims: [{ text: "fact", sourceUrl: "javascript:alert(1)" }],
      }),
    ).toBeTruthy();
    expect(
      validateDocument({ ...document, scenes: [document.scenes[0]!, document.scenes[0]!] }),
    ).toBeTruthy();
    expect(
      validateDocument({
        ...document,
        scenes: document.scenes.map((s) => ({
          ...s,
          characterRefs: [{ characterId: "c", versionId: "v" }],
        })),
      }),
    ).toContain("character version only once");
  });
  it("rebases disjoint changes while rejecting overlapping scene or header edits", () => {
    const local = patchScene(document, "scene-one", { dialogue: "Local" });
    const remote = patchScene(document, "scene-two", { camera: "Server camera" });
    const merged = mergeRevision(document, local, remote);
    expect(merged.scenes[0]?.dialogue).toBe("Local");
    expect(merged.scenes[1]?.camera).toBe("Server camera");
    expect(() =>
      mergeRevision(document, local, patchScene(document, "scene-one", { dialogue: "Other" })),
    ).toThrow();
    expect(() =>
      mergeRevision(document, { ...document, title: "Local" }, { ...document, title: "Remote" }),
    ).toThrow();
  });
});
describe("M24 HTTP integration adapter", () => {
  it("sends exact edit/archive timestamps, credentials, and scoped URLs", async () => {
    const fetch = vi.fn().mockImplementation(async () => response(idea));
    vi.stubGlobal("fetch", fetch);
    await client().editIdea(idea, draftFromIdea(idea));
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/workspace-one/ideas/idea-one");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", credentials: "include" });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
      expectedUpdatedAt: idea.updatedAt,
    });
    await client().archiveIdea(idea);
    await client().archiveIdea(idea, true);
    expect(fetch.mock.calls[1]?.[1].method).toBe("DELETE");
    expect(fetch.mock.calls[2]?.[0]).toContain("/restore");
  });
  it("does not dispatch viewer writes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(client("VIEWER").createIdea(draftFromIdea(idea))).rejects.toMatchObject({
      status: 403,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("suspends revoked sessions and rejects foreign resource data", async () => {
    const denied = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "Denied" }, 403)));
    await expect(client("EDITOR", denied).ideas()).rejects.toMatchObject({ status: 403 });
    expect(denied).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response([{ ...idea, workspaceId: "foreign" }])),
    );
    await expect(client().ideas()).rejects.toThrow("out-of-workspace");
  });
  it("writes idea status with the observed timestamp/status, then refreshes canonical state", async () => {
    const saved = { ...idea, status: "BACKLOG", updatedAt: "2026-11-12T01:00:00.000Z" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ ...idea, status: "BACKLOG" }))
      .mockResolvedValueOnce(response([saved]));
    vi.stubGlobal("fetch", fetch);
    expect(await client().transitionIdea(idea, "BACKLOG")).toEqual(saved);
    expect(fetch.mock.calls[0]?.[1].method).toBe("PATCH");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      status: "BACKLOG",
      expectedStatus: idea.status,
      expectedUpdatedAt: idea.updatedAt,
    });
  });
  it.each(["status", "revision", "approval"] as const)(
    "does not retry a stale %s precondition or substitute a freshly fetched token",
    async (operation) => {
      const fetch = vi.fn().mockResolvedValue(response({ message: "Version changed" }, 409));
      vi.stubGlobal("fetch", fetch);
      const api = client();
      await expect(
        operation === "status"
          ? api.transitionIdea(idea, "BACKLOG")
          : operation === "revision"
            ? api.reviseScript(script, document)
            : api.approveScript(script),
      ).rejects.toMatchObject({ status: 409 });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1].method).not.toBe("GET");
    },
  );
  it("persists the complete targeted document with the observed revision envelope", async () => {
    const changed = patchScene(document, "scene-one", { dialogue: "My edit" });
    const saved = {
      ...script,
      status: "REVISION_PENDING",
      currentRevision: 2,
      revisions: [{ revision: 2, document: changed }],
    };
    const fetch = vi.fn().mockResolvedValue(response(saved));
    vi.stubGlobal("fetch", fetch);
    expect(await client().reviseScript(script, changed)).toEqual(saved);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      expectedRevision: 1,
      document: changed,
    });
    expect(saved.revisions[0]?.document.scenes[1]).toEqual(document.scenes[1]);
  });
  it("approves the explicitly reviewed revision and reads canonical approval and export", async () => {
    const exported = {
      scriptId: script.id,
      revision: 1,
      approvedIdeaSnapshotId: "snapshot-one",
      document,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(exported))
      .mockResolvedValueOnce(response({ ...script, status: "APPROVED" }))
      .mockResolvedValueOnce(response(exported));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect((await api.approveScript(script)).status).toBe("APPROVED");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedRevision: 1 });
    expect(await api.exportScript(script.id, 1)).toEqual(exported);
  });
  it("validates approval acknowledgements and forbids immutable script edits", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ scriptId: script.id, revision: 2, approvedIdeaSnapshotId: "s", document }),
        ),
    );
    await expect(client().approveScript(script)).rejects.toThrow("Invalid approved");
    await expect(
      client().reviseScript({ ...script, status: "APPROVED" }, document),
    ).rejects.toThrow("immutable");
  });
  it.each(["status", "revision", "approval"] as const)(
    "blocks Viewer %s writes",
    async (operation) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const api = client("VIEWER");
      await expect(
        operation === "status"
          ? api.transitionIdea(idea, "BACKLOG")
          : operation === "revision"
            ? api.reviseScript(script, document)
            : api.approveScript(script),
      ).rejects.toMatchObject({ status: 403 });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("uses actual paged list/history endpoints and no provider calls", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ items: [script], nextPage: null }))
      .mockResolvedValueOnce(response({ items: script.revisions, nextPage: null }));
    vi.stubGlobal("fetch", fetch);
    await client().scripts();
    await client().history(script.id);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/workspaces/workspace-one/scripts?page=1",
      "/api/v1/workspaces/workspace-one/scripts/script-one/revisions?page=1",
    ]);
  });
  it("sends generation checksum and snapshot IDs to M07 without inventing saved data", async () => {
    const fetch = vi.fn().mockResolvedValue(response(script));
    vi.stubGlobal("fetch", fetch);
    const input = {
      approvedIdeaSnapshotId: "a",
      approvedIdeaChecksum: "checksum",
      configSnapshotId: "config",
      promptSnapshotId: "prompt",
      prompt: "Generate",
    };
    await client().generateScript(input);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(input);
  });
  it("keeps failed generation pending until it is reconciled", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {});
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const fetch = vi.fn().mockResolvedValue(response({ message: "Rejected" }, 409));
    vi.stubGlobal("fetch", fetch);
    const input = {
      approvedIdeaSnapshotId: "a",
      approvedIdeaChecksum: "checksum",
      configSnapshotId: "config",
      promptSnapshotId: "prompt",
      prompt: "Generate",
    };
    await expect(client().generateScript(input)).rejects.toThrow();
    expect(pendingSave(idea.workspaceId)).toBe("scripts");
    await expect(client().generateScript(input)).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
    clearPendingSave(idea.workspaceId);
  });
  it("keeps uncertain writes pending and never automatically retries them", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {});
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    const fetch = vi.fn().mockRejectedValue(new Error("Lost response"));
    vi.stubGlobal("fetch", fetch);
    await expect(client().createIdea(draftFromIdea(idea))).rejects.toMatchObject({
      uncertain: true,
    });
    expect(pendingSave(idea.workspaceId)).toBe("ideas");
    await expect(client().createIdea(draftFromIdea(idea))).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
    clearPendingSave(idea.workspaceId);
    expect(pendingSave(idea.workspaceId)).toBeNull();
  });
  it("cancels requests on workspace teardown", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new PlanningClient("workspace-one", "OWNER", controller.signal).ideas(),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
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
    "keeps pending writes blocked after a failed affected-resource read (%s)",
    async (status) => {
      storage();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response({ message: "Read failed" }, status)),
      );
      await expect(client().reconcilePendingSave()).rejects.toThrow();
      expect(pendingSave(idea.workspaceId)).toBe("ideas/idea-one");
      await expect(client().editIdea(idea, draftFromIdea(idea))).rejects.toMatchObject({
        status: 409,
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
describe("R3 sequential storyboard timing policy", () => {
  it.each([5, 15])(
    "rejects an overlap or gap at second-scene start %s without changing it",
    (startSeconds) => {
      const changed = patchScene(document, "scene-two", { startSeconds });
      expect(validateDocument(changed)).toContain("without gaps or overlaps");
      expect(changed.scenes[1]?.startSeconds).toBe(startSeconds);
      expect(
        validateDocument({ ...changed, scenes: normalizeSceneTimings(changed.scenes) }),
      ).toBeNull();
    },
  );
});
