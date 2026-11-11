import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelsClient, guardRecord } from "./api";
import { canEdit, channelPayload, filterChannels, formPayload, type Channel } from "./model";
import { validateAsset } from "./asset-validation";
const channel: Channel = {
  id: "ch-1",
  workspaceId: "w-1",
  name: "Curious Minutes",
  status: "ACTIVE",
  handle: "@curious",
  niche: "Science",
};
function mockResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());
describe("M23 workspace and permission boundary", () => {
  it("rejects UNKNOWN and VIEWER mutations before sending a request", async () => {
    const fetch = mockResponse(channel);
    for (const role of ["UNKNOWN", "VIEWER"] as const) {
      const client = new ChannelsClient("w-1", new AbortController().signal, role);
      await expect(
        client.request("channels", { method: "POST", body: { name: "New" } }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(canEdit("EDITOR")).toBe(true);
  });
  it("does not allow the preview flag to bypass mutation permissions", async () => {
    const fetch = mockResponse(channel);
    const client = new ChannelsClient("w-1", new AbortController().signal);
    await expect(
      client.request("channels", { method: "POST", readOnly: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows deterministic resolution without inventing a role", async () => {
    const fetch = mockResponse({ config: {}, layers: [], locks: [] });
    const client = new ChannelsClient("w-1", new AbortController().signal);
    await client.request("config/resolve", {
      method: "POST",
      readOnly: true,
      body: { channelId: "ch-1" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/workspaces/w-1/config/resolve",
      expect.objectContaining({ credentials: "include", method: "POST" }),
    );
  });
  it("uses the explicitly selected workspace, rejects another tenant's response", async () => {
    const fetch = mockResponse([{ ...channel, workspaceId: "w-2" }]);
    const client = new ChannelsClient("w-1", new AbortController().signal);
    await expect(client.channels()).rejects.toMatchObject({ status: 502 });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/w-1/channels");
  });
  it("cancels pending mutations and discards stale successes after workspace change", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    const controller = new AbortController();
    const client = new ChannelsClient("w-1", controller.signal, "OWNER");
    const pending = client.request("channels/ch-1", { method: "PATCH", body: { name: "Changed" } });
    controller.abort();
    resolve(new Response(JSON.stringify(channel)));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("aborts before an old scope can send another request", async () => {
    const fetch = mockResponse(channel);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ChannelsClient("w-1", controller.signal, "OWNER").channel("ch-1"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends authenticated editor mutations and preserves structured policy payloads", async () => {
    const fetch = mockResponse(channel);
    await new ChannelsClient("w-1", new AbortController().signal, "EDITOR").request(
      "channels/ch-1",
      { method: "PATCH", body: { approvalPolicy: { requiresHumanReview: true } } },
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      approvalPolicy: { requiresHumanReview: true },
    });
  });
});
describe("M23 response and error handling", () => {
  it.each([401, 403, 404, 409, 500])(
    "preserves HTTP %i without fabricating saved data",
    async (status) => {
      mockResponse({ message: "Fixture rejection" }, status);
      await expect(
        new ChannelsClient("w-1", new AbortController().signal).channels(),
      ).rejects.toMatchObject({ status });
    },
  );
  it("reports offline failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network failure")));
    await expect(
      new ChannelsClient("w-1", new AbortController().signal).channels(),
    ).rejects.toMatchObject({ status: 0 });
  });
  it.each([
    {},
    [{ ...channel, status: "DELETED" }],
    [{ ...channel, name: 42 }],
    [{ ...channel, workspaceId: undefined }],
  ])("rejects malformed channel lists", async (body) => {
    mockResponse(body);
    await expect(
      new ChannelsClient("w-1", new AbortController().signal).channels(),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("requires valid immutable versions and assets", () => {
    expect(() => guardRecord({ id: "v", version: 0 }, "version", "w-1")).toThrow();
    expect(() =>
      guardRecord({ id: "a", version: 1, status: "PUBLISHED" }, "asset", "w-1"),
    ).toThrow();
  });
  it("accepts delete endpoints with no content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(
      new ChannelsClient("w-1", new AbortController().signal, "EDITOR").request(
        "character-groups/g/members/c",
        { method: "DELETE" },
      ),
    ).resolves.toEqual({});
  });
});
describe("M23 editing and discovery", () => {
  it("searches names, handles and niches with lifecycle filters", () => {
    expect(filterChannels([channel], " SCIENCE ", "ACTIVE")).toEqual([channel]);
    expect(filterChannels([channel], "@curious", "ARCHIVED")).toEqual([]);
  });
  it("omits unsupported empty clears and validates timezone/name", () => {
    expect(channelPayload({ name: " New ", handle: "", timezone: "Asia/Kolkata" })).toEqual({
      name: "New",
      timezone: "Asia/Kolkata",
    });
    expect(() => channelPayload({ name: "" })).toThrow();
    expect(() => channelPayload({ name: "New", timezone: "bad/zone" })).toThrow();
  });
  it("validates advanced policies without silently inventing defaults", () => {
    expect(() =>
      formPayload([{ key: "policy", label: "Policy", kind: "object" }], { policy: "[]" }),
    ).toThrow();
    expect(() =>
      formPayload([{ key: "refs", label: "References", kind: "array" }], { refs: "{}" }),
    ).toThrow();
    expect(
      formPayload(
        [
          { key: "name", label: "Name" },
          { key: "description", label: "Description", optional: true },
        ],
        { name: " Series ", description: "" },
      ),
    ).toEqual({ name: "Series" });
  });
  it("requires licensed media and explicit attestation", () => {
    const file = { name: "cover.png", type: "image/png", size: 100 };
    expect(() => validateAsset(file, "Author", "CC0-1.0", false)).toThrow(/attestation/);
    expect(() =>
      validateAsset({ ...file, size: 26 * 1024 * 1024 }, "Author", "CC0-1.0", true),
    ).toThrow(/25 MB/);
    expect(() =>
      validateAsset({ ...file, name: "../cover.png" }, "Author", "CC0-1.0", true),
    ).toThrow(/filename/);
    expect(() => validateAsset(file, "Author", "CC0-1.0", true)).not.toThrow();
  });
});

describe("M23 persisted-result integrity", () => {
  it("rejects empty mutation acknowledgements instead of reporting a saved entity", async () => {
    mockResponse({});
    await expect(
      new ChannelsClient("w-1", new AbortController().signal, "EDITOR").request("genres", {
        method: "POST",
        body: { name: "Example" },
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("rejects another channel even within the selected workspace", async () => {
    mockResponse({ ...channel, id: "ch-2" });
    await expect(
      new ChannelsClient("w-1", new AbortController().signal).channel("ch-1"),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("does not present an incomplete prompt preview as successful", async () => {
    mockResponse({ config: {}, template: {} });
    await expect(
      new ChannelsClient("w-1", new AbortController().signal).request("prompts/preview", {
        method: "POST",
        readOnly: true,
        body: {},
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
