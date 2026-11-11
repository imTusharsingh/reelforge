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
  it("accepts OWNER, EDITOR and VIEWER memberships", async () => {
    for (const role of ["OWNER", "EDITOR", "VIEWER"] as const) {
      const payload = [{ id: "w-1", name: "Studio", role }];
      const response = new Response(JSON.stringify(payload));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(api.listWorkspaces()).resolves.toMatchObject([{ role }]);
    }
    vi.unstubAllGlobals();
  });

  it("rejects missing or untrusted roles", async () => {
    for (const role of [undefined, "UNKNOWN", "ADMIN", null, 1]) {
      const payload = [{ id: "w-1", name: "Studio", role }];
      const response = new Response(JSON.stringify(payload));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 502 });
    }
    vi.unstubAllGlobals();
  });

  it("requires a verified list after workspace creation", async () => {
    const response = new Response(JSON.stringify({ id: "w-1", name: "Studio" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(api.createWorkspace("Studio")).resolves.toEqual({ id: "w-1", name: "Studio" });
    await expect(api.listWorkspaces()).rejects.toMatchObject({ status: 502 });
    vi.unstubAllGlobals();
  });
});
