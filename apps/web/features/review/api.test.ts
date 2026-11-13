import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewClient } from "./api";
import { review, workspaceId } from "./verification/fixtures";
const reason = "I inspected the pinned review evidence";
const saved = {
  ...review,
  status: "APPROVED",
  decisions: [
    {
      id: "decision-1",
      action: "APPROVE",
      reason,
      overrideReason: null,
      actorUserId: "reviewer-id",
      createdAt: review.createdAt,
    },
  ],
};
function client(role: "OWNER" | "EDITOR" | "VIEWER" = "EDITOR"): ReviewClient {
  return new ReviewClient(workspaceId, role, new AbortController().signal);
}
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("M26 authenticated API and decision reconciliation", () => {
  it("fails closed when browser recovery storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("Storage denied");
      },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(client().decide(review, { action: "APPROVE", reason }, [])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("isolates uncertain outcomes by workspace and resource", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Interrupted")));
    const api = client();
    await expect(api.decide(review, { action: "APPROVE", reason }, [])).rejects.toThrow();
    expect(api.uncertain(review.id)).toBe(true);
    expect(
      new ReviewClient("other-workspace", "EDITOR", new AbortController().signal).uncertain(
        review.id,
      ),
    ).toBe(false);
    expect(api.uncertain("different-run")).toBe(false);
  });
  it("scopes every read to the workspace with cookies and rejects foreign records", async () => {
    const fetch = vi.fn().mockResolvedValue(json([review]));
    vi.stubGlobal("fetch", fetch);
    expect(await client().queue()).toEqual([review]);
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/workspaces/${workspaceId}/quality/queue`,
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );
    fetch.mockResolvedValueOnce(json([{ ...review, workspaceId: "foreign" }]));
    await expect(client().queue()).rejects.toThrow();
  });
  it("Viewer never dispatches writes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      client("VIEWER").decide(review, { action: "APPROVE", reason }, []),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "EDITOR"] as const)("%s submits one validated decision", async (role) => {
    const fetch = vi.fn().mockResolvedValue(json(saved));
    vi.stubGlobal("fetch", fetch);
    expect((await client(role).decide(review, { action: "APPROVE", reason }, [])).status).toBe(
      "APPROVED",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      action: "APPROVE",
      reason,
    });
  });
  it.each(["interrupted", "unreadable", "malformed", "mismatched"])(
    "reconciles %s successful mutation without replay",
    async (mode) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      if (mode === "interrupted") fetch.mockRejectedValueOnce(new TypeError("network interrupted"));
      else
        fetch.mockResolvedValueOnce(
          mode === "unreadable"
            ? new Response("{")
            : json(mode === "malformed" ? {} : { ...saved, id: "wrong" }),
        );
      const api = client();
      await expect(api.decide(review, { action: "APPROVE", reason }, [])).rejects.toMatchObject({
        uncertain: true,
      });
      expect(client().uncertain(review.id)).toBe(true);
      await expect(api.decide(review, { action: "APPROVE", reason }, [])).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(() => api.acknowledge(review.id)).toThrow();
      fetch.mockResolvedValueOnce(json(saved));
      expect((await api.reconcile(review.id)).status).toBe("APPROVED");
      api.acknowledge(review.id);
      expect(api.uncertain(review.id)).toBe(false);
      expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
        "POST",
        "GET",
      ]);
    },
  );
  it("keeps blocked after reconciliation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError()));
    const api = client();
    await expect(api.decide(review, { action: "REJECT", reason }, [])).rejects.toThrow();
    await expect(api.reconcile(review.id)).rejects.toThrow();
    expect(() => api.acknowledge(review.id)).toThrow();
    expect(api.uncertain(review.id)).toBe(true);
  });
  it.each([401, 403, 404, 409, 500])("handles %s without blind repeats", async (status) => {
    const fetch = vi.fn().mockResolvedValue(json({}, status));
    vi.stubGlobal("fetch", fetch);
    const api = client();
    await expect(api.decide(review, { action: "REJECT", reason }, [])).rejects.toMatchObject({
      status,
    });
    await expect(api.decide(review, { action: "REJECT", reason }, [])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(api.suspended).toBe([401, 403].includes(status));
  });
  it("prevents simultaneous submissions", async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = client();
    const first = api.decide(review, { action: "APPROVE", reason }, []);
    await expect(api.decide(review, { action: "APPROVE", reason }, [])).rejects.toThrow();
    release(json(saved));
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
