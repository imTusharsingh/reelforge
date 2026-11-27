import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishingClient } from "./api";
import {
  accounts,
  accountId,
  post,
  publishedRecord,
  secondWorkspaceId,
  workspaceId,
} from "./fixtures.fixture";

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
  it("requires the scoped account and confirmed REVOKED status in a disconnect response", async () => {
    const account = accounts[0]!;
    const revoked = { ...account, status: "REVOKED", health: "AUTH_REQUIRED" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(revoked))
      .mockResolvedValueOnce(json({ ...revoked, workspaceId: secondWorkspaceId }));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await expect(api.revokeAccount(accountId)).resolves.toEqual(revoked);
    await expect(api.revokeAccount(accountId)).rejects.toMatchObject({ uncertain: true });
    expect(api.pendingAccountScopes()).toEqual([`account:${accountId}`]);
  });

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
