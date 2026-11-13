import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishingApiError, PublishingClient } from "./api";
import {
  accounts,
  accountId,
  blockedPreflight,
  createRequest,
  passingPreflight,
  post,
  publishedRecord,
  secondWorkspaceId,
  workspaceId,
} from "./verification/fixtures";

function client(role: "OWNER" | "EDITOR" | "VIEWER" = "EDITOR"): PublishingClient {
  return new PublishingClient(workspaceId, role, new AbortController().signal);
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("M27 publishing client", () => {
  it("scopes reads to the workspace and never trusts foreign records", async () => {
    const fetch = vi.fn().mockResolvedValue(json([publishedRecord]));
    vi.stubGlobal("fetch", fetch);
    expect(await client().history()).toEqual([publishedRecord]);
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/workspaces/${workspaceId}/publishing/published-records`,
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );
    fetch.mockResolvedValueOnce(json([{ ...publishedRecord, workspaceId: secondWorkspaceId }]));
    await expect(client().history()).rejects.toThrow();
  });

  it("reads drafts, calendar, eligible renders and preflight through validated parsers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [post], nextCursor: null }))
      .mockResolvedValueOnce(json([post]))
      .mockResolvedValueOnce(
        json({
          items: [
            {
              renderJobId: post.renderJobId,
              channelId: post.channelId,
              projectId: "20000000-0000-4000-8000-000000000011",
              title: "Fixture",
              durationMs: 42_000,
              completedAt: "2026-11-13T09:00:00.000Z",
              qualityReviewRunId: post.qualityReviewRunId,
              reviewStatus: "APPROVED",
              reviewedAt: "2026-11-13T09:05:00.000Z",
            },
          ],
          nextCursor: "next",
        }),
      )
      .mockResolvedValueOnce(json(blockedPreflight));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect((await api.drafts()).items).toEqual([post]);
    expect((await api.calendar("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"))[0]?.id).toBe(
      post.id,
    );
    expect((await api.eligibleRenders(post.channelId, "cursor")).nextCursor).toBe("next");
    expect((await api.preflight(blockedPreflight.destinationId)).canPublish).toBe(false);
    expect(fetch.mock.calls[2]![0]).toContain("channelId=");
    expect(fetch.mock.calls[2]![0]).toContain("cursor=cursor");
    fetch.mockResolvedValueOnce(json({ ...blockedPreflight, destinationId: "other" }));
    await expect(api.preflight(blockedPreflight.destinationId)).rejects.toThrow();
  });

  it("keeps Viewer and inaccessible roles read-only before dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(client("VIEWER").createPost(createRequest)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates one post with a persisted idempotency request and clears the marker", async () => {
    const fetch = vi.fn().mockResolvedValue(json(post));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect(await api.createPost(createRequest)).toEqual(post);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string) as typeof createRequest;
    expect(body.clientRequestId).toBe(createRequest.clientRequestId);
    expect(api.pending(`create:${createRequest.clientRequestId}`)).toBe(false);
    expect(api.pendingCreate()).toBeNull();
  });

  it("recovers an interrupted creation by replaying only the exact saved request", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network interrupted"));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await expect(api.createPost(createRequest)).rejects.toMatchObject({ uncertain: true });
    expect(api.pending(`create:${createRequest.clientRequestId}`)).toBe(true);
    expect(api.pendingCreate()).toEqual(createRequest);

    fetch.mockResolvedValueOnce(json(post));
    expect(await api.recoverCreate(createRequest)).toEqual(post);
    expect(api.pendingCreate()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual(createRequest);
  });

  it("clears the pending marker after a definitive rejection but not after an ambiguous one", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ message: "invalid" }, 400));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await expect(api.createPost(createRequest)).rejects.toMatchObject({ status: 400 });
    expect(api.pendingCreate()).toBeNull();

    fetch.mockResolvedValueOnce(json({}, 503));
    await expect(api.createPost(createRequest)).rejects.toMatchObject({ uncertain: true });
    expect(api.pendingCreate()).toEqual(createRequest);
  });

  it("prevents simultaneous writes from repeating a request", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = client();
    const first = api.createPost(createRequest);
    await expect(api.createPost(createRequest)).rejects.toBeInstanceOf(PublishingApiError);
    release(json(post));
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires reconciliation before acknowledging an uncertain post action", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("interrupted"));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await expect(api.publishNow(post.id, post.destinations[0]!.id)).rejects.toMatchObject({
      uncertain: true,
    });
    expect(api.pending(`post:${post.id}`)).toBe(true);
    expect(() => api.acknowledge(`post:${post.id}`)).toThrow();
    fetch.mockResolvedValueOnce(json(post));
    expect((await api.reconcilePost(post.id)).id).toBe(post.id);
    api.acknowledge(`post:${post.id}`);
    expect(api.pending(`post:${post.id}`)).toBe(false);
  });

  it("confirms publish, retry and reconcile responses belong to the destination", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(post))
      .mockResolvedValueOnce(json(post))
      .mockResolvedValueOnce(json(post));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect((await api.publishNow(post.id, passingPreflight.destinationId)).id).toBe(post.id);
    expect((await api.retry(post.id, passingPreflight.destinationId)).id).toBe(post.id);
    expect((await api.reconcileDestination(post.id, passingPreflight.destinationId)).id).toBe(
      post.id,
    );
    fetch.mockResolvedValueOnce(json({ ...post, destinations: [] }));
    await expect(api.publishNow(post.id, passingPreflight.destinationId)).rejects.toThrow();
    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("accepts only secure authorization URLs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ authorizationUrl: "https://accounts.example.test/auth" }))
      .mockResolvedValueOnce(json({ authorizationUrl: "http://accounts.example.test/auth" }));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect(await api.connect(post.channelId, "YOUTUBE", "remote")).toBe(
      "https://accounts.example.test/auth",
    );
    await expect(api.connect(post.channelId, "YOUTUBE", "remote")).rejects.toThrow();
  });
});

describe("account action recovery", () => {
  it("keeps interrupted actions locked across reload until accounts are inspected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "Unavailable" }, 503))
      .mockImplementation(() => Promise.resolve(json(accounts)));
    vi.stubGlobal("fetch", fetch);
    const first = client();
    await expect(first.refreshAccount(accountId)).rejects.toMatchObject({ uncertain: true });
    const reloaded = client();
    const scope = `account:${accountId}`;
    expect(reloaded.pendingAccountScopes()).toEqual([scope]);
    expect(() => reloaded.acknowledge(scope)).toThrow("Fetch the persisted");
    await expect(reloaded.revokeAccount(accountId)).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await reloaded.reconcileAccounts();
    reloaded.acknowledge(scope);
    expect(reloaded.pendingAccountScopes()).toEqual([]);
  });
});
