import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryScout } from "./scout.js";
import { DiscoveryYouTube } from "./youtube.js";
import { briefFixture, candidateFixture, context, now } from "./discovery.fixture.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("V10 V2 grounding and YouTube fakes", () => {
  it("uses the landed V2 TextPort with grounding and validates structured output", async () => {
    const text = { complete: vi.fn() },
      ports = vi.fn().mockResolvedValue({ text, assertKey: vi.fn() });
    const reserve = vi.fn().mockResolvedValue(true),
      youtube = { sources: vi.fn().mockResolvedValue([]) };
    const complete = vi.fn(
      async (
        _context: unknown,
        _channel: unknown,
        _text: unknown,
        spec: { parse: (value: unknown) => unknown },
      ): Promise<unknown> => spec.parse([candidateFixture()]),
    );
    const scout = new DiscoveryScout(
      { ports } as never,
      { reserve } as never,
      youtube as never,
      { complete } as never,
    );
    expect(await scout.discover(context, briefFixture(), [], [], "key", now)).toEqual([
      candidateFixture(),
    ]);
    expect(complete.mock.calls[0]?.[3]).toMatchObject({ grounding: true });
    expect(reserve).toHaveBeenCalledWith(context.workspaceId, "grounding", now);
    reserve.mockResolvedValue(false);
    expect(await scout.discover(context, briefFixture(), [], [], "next", now)).toEqual([]);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("uses fake charts/search and reserves the search bucket before search.list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("YOUTUBE_DATA_API_KEY", "fake-key");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async (): Promise<unknown> => ({
          items: [{ id: "chart", snippet: { title: "Chart" } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async (): Promise<unknown> => ({
          items: [{ id: { videoId: "search" }, snippet: { title: "Search" } }],
        }),
      });
    vi.stubGlobal("fetch", fetcher);
    const reserve = vi.fn().mockResolvedValue(true),
      client = new DiscoveryYouTube({ reserve } as never);
    const sources = await client.sources(context.workspaceId, "science", now);
    expect(sources.map((s) => s.url)).toEqual([
      "https://www.youtube.com/watch?v=chart",
      "https://www.youtube.com/watch?v=search",
    ]);
    expect(reserve).toHaveBeenCalledWith(context.workspaceId, "youtube", now);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("/search?");
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[1]!);
  });
  it("skips unconfigured/test YouTube and never dispatches a capped search", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async (): Promise<unknown> => ({ items: [] }) });
    vi.stubGlobal("fetch", fetcher);
    const client = new DiscoveryYouTube({ reserve: vi.fn().mockResolvedValue(false) } as never);
    vi.stubEnv("YOUTUBE_DATA_API_KEY", "");
    expect(await client.sources(context.workspaceId, "science", now)).toEqual([]);
    vi.stubEnv("YOUTUBE_DATA_API_KEY", "fake");
    vi.stubEnv("NODE_ENV", "test");
    expect(await client.sources(context.workspaceId, "science", now)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "development");
    expect(await client.sources(context.workspaceId, "science", now)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue({ ok: false, status: 429 });
    await expect(client.sources(context.workspaceId, "science", now)).rejects.toThrow("429");
    fetcher.mockResolvedValue({
      ok: true,
      json: async (): Promise<unknown> => ({ items: [{ bad: true }] }),
    });
    await expect(client.sources(context.workspaceId, "science", now)).rejects.toThrow();
  });
});
