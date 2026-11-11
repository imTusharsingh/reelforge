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
