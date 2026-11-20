import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryService, discoverySlot } from "./service.js";
import { initialLearning } from "./scoring.js";
import { briefFixture, candidateFixture, context, channelId, now } from "./discovery.fixture.js";

function fixture(): {
  service: DiscoveryService;
  store: Record<string, ReturnType<typeof vi.fn>>;
  scout: { discover: ReturnType<typeof vi.fn> };
  db: {
    channel: { findMany: ReturnType<typeof vi.fn> };
    workspaceMembership: { findFirst: ReturnType<typeof vi.fn> };
  };
} {
  const brief = briefFixture();
  const store = {
    brief: vi.fn().mockResolvedValue(brief),
    claim: vi.fn().mockResolvedValue(true),
    learn: vi.fn().mockResolvedValue(initialLearning(brief)),
    history: vi.fn().mockResolvedValue([]),
    finish: vi.fn().mockResolvedValue(undefined),
    failure: vi.fn().mockResolvedValue(undefined),
  };
  const scout = {
    discover: vi
      .fn()
      .mockResolvedValue([candidateFixture(), candidateFixture("What makes stars shine")]),
  };
  const analytics = {
    samples: vi.fn().mockResolvedValue([]),
    sources: vi.fn().mockReturnValue([]),
  };
  const db = {
    channel: {
      findMany: vi.fn().mockResolvedValue([{ id: channelId, workspaceId: context.workspaceId }]),
    },
    workspaceMembership: { findFirst: vi.fn().mockResolvedValue(context) },
  };
  return {
    service: new DiscoveryService(db as never, store as never, scout as never, analytics as never),
    store,
    scout,
    db,
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("V10 autonomous scheduled discovery", () => {
  it("scheduled tick produces ranked sourced ideas from a versioned Brief without user input", async () => {
    const { service, store, scout } = fixture();
    await service.scheduledTick(now);
    expect(scout.discover).toHaveBeenCalledOnce();
    const ideas = store.finish!.mock.calls[0]![3] as Array<{
      score: number;
      sources: unknown[];
      id: string;
    }>;
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.score).toBeGreaterThan(0);
    expect(ideas[0]!.sources).toHaveLength(1);
    expect(store.finish).toHaveBeenCalledWith(context, briefFixture(), "2026-11-16", ideas, now);
  });
  it("dedupes schedule claims and topics inside cooldown before persistence", async () => {
    const { service, store, scout } = fixture();
    store.claim!.mockResolvedValueOnce(false);
    expect(await service.tick(context, channelId, now)).toEqual([]);
    expect(scout.discover).not.toHaveBeenCalled();
    store.history!.mockResolvedValue([{ topic: candidateFixture().topic, createdAt: now }]);
    const ranked = await service.tick(context, channelId, now);
    expect(ranked.map((row) => row.topic)).toEqual(["What makes stars shine"]);
  });
  it("audits failures, avoids replaying paid calls, and isolates failed channels", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, store, scout, db } = fixture();
    scout.discover.mockRejectedValue(new Error("provider down"));
    await expect(service.tick(context, channelId, now)).rejects.toThrow("provider down");
    expect(store.failure).toHaveBeenCalledWith(context, channelId, "2026-11-16");
    await service.scheduledTick(now);
    db.workspaceMembership.findFirst.mockResolvedValue(null);
    const calls = scout.discover.mock.calls.length;
    await service.scheduledTick(now);
    expect(scout.discover).toHaveBeenCalledTimes(calls);
  });
  it("uses the Brief timezone at day boundaries", () => {
    expect(discoverySlot(new Date("2026-11-16T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-17");
  });
});
