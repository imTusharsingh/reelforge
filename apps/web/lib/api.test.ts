import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("API response boundaries", () => {
  it("rejects malformed workspace payloads instead of passing them to the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 42 }]), { status: 200 })),
    );
    await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 502 } as Partial<ApiError>);
  });

  it("rejects malformed successful JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(api.logout()).rejects.toMatchObject({ status: 502 } as Partial<ApiError>);
  });
});

describe("verified workspace role contract", () => {
  it.each(["OWNER", "EDITOR", "VIEWER"] as const)("accepts %s membership", async (role) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "w-1", name: "Studio", archivedAt: null, role }])),
      ),
    );
    await expect(api.listWorkspaces()).resolves.toMatchObject([{ role }]);
    vi.unstubAllGlobals();
  });

  it.each([undefined, "UNKNOWN", "ADMIN", null, 1])(
    "rejects missing or untrusted role %s",
    async (role) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify([{ id: "w-1", name: "Studio", archivedAt: null, role }])),
        ),
      );
      await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 502 });
      vi.unstubAllGlobals();
    },
  );

  it("accepts a role-free create acknowledgement but rejects it as a membership list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "w-1", name: "Studio" })),
      ),
    );
    await expect(api.createWorkspace("Studio")).resolves.toEqual({ id: "w-1", name: "Studio" });
    await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 502 });
    vi.unstubAllGlobals();
  });
});
