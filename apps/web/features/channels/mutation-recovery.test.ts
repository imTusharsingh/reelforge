import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelsClient } from "./api";
import { pendingSave, clearPendingSave } from "./mutation-recovery";
import { ids, channel } from "./verification/fixtures";
afterEach(() => vi.unstubAllGlobals());
describe("uncertain save reconciliation", () => {
  function storage(): Map<string, string> {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string): string | null => items.get(key) ?? null,
        setItem: (key: string, value: string): void => {
          items.set(key, value);
        },
        removeItem: (key: string): void => {
          items.delete(key);
        },
      },
    });
    return items;
  }
  it("keeps only path metadata after a failed network save and blocks blind retries", async () => {
    const items = storage();
    const fetch = vi.fn().mockRejectedValue(new TypeError("connection lost"));
    vi.stubGlobal("fetch", fetch);
    const client = new ChannelsClient(ids.workspace, new AbortController().signal, "EDITOR");
    await expect(
      client.request(`channels/${ids.channel}`, {
        method: "PATCH",
        body: { name: "private draft" },
      }),
    ).rejects.toMatchObject({ status: 0 });
    expect(pendingSave(ids.workspace)).toBe(`channels/${ids.channel}`);
    expect([...items.values()].join()).not.toContain("private draft");
    await expect(
      client.request(`channels/${ids.channel}`, { method: "PATCH", body: { name: "retry" } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    clearPendingSave(ids.workspace);
    expect(pendingSave(ids.workspace)).toBeNull();
  });
  it("clears the marker only after a validated server acknowledgement", async () => {
    storage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(channel))));
    const client = new ChannelsClient(ids.workspace, new AbortController().signal, "OWNER");
    await client.request(`channels/${ids.channel}`, {
      method: "PATCH",
      body: { name: channel.name },
    });
    expect(pendingSave(ids.workspace)).toBeNull();
  });
  it("retains recovery metadata for malformed success payloads", async () => {
    storage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: ids.channel }))),
    );
    await expect(
      new ChannelsClient(ids.workspace, new AbortController().signal, "OWNER").request(
        `channels/${ids.channel}`,
        { method: "PATCH", body: { name: "Edited" } },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(pendingSave(ids.workspace)).not.toBeNull();
  });
});
