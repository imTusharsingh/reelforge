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
afterEach(() => vi.unstubAllGlobals());
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
  it("rejects stale script preflight without issuing POST", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response({
        ...script,
        currentRevision: 2,
        revisions: [{ ...script.revisions[0], revision: 2 }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(client().reviseScript(script, document)).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("posts an entire valid revision with no invented API fields", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(script))
      .mockResolvedValueOnce(response(script));
    vi.stubGlobal("fetch", fetch);
    await client().reviseScript(script, document);
    expect(fetch.mock.calls[1]?.[0]).toContain("/scripts/script-one/revisions");
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual(document);
  });
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
