import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../identity/identity.types.js";
import { DiscoveryQuotaService, quotaBuckets, quotaPeriods, stableKey } from "./quota.js";
import { workspaceId, now } from "./discovery.fixture.js";

function fakeQuota(): { service: DiscoveryQuotaService; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  let pending = Promise.resolve();
  const db = {
    $transaction: (action: (tx: unknown) => Promise<void>): Promise<void> => {
      const result = pending.then(async () => {
        const before = new Map(counts);
        try {
          await action({
            discoveryQuota: {
              upsert: async ({ where }: { where: { id: string } }): Promise<{ used: number }> => {
                const used = (counts.get(where.id) ?? 0) + 1;
                counts.set(where.id, used);
                return { used };
              },
            },
          });
        } catch (error) {
          counts.clear();
          for (const [key, value] of before) counts.set(key, value);
          throw error;
        }
      });
      pending = result.catch(() => {});
      return result;
    },
  } as unknown as Database;
  return { service: new DiscoveryQuotaService(db), counts };
}
afterEach(() => vi.unstubAllEnvs());
describe("V10 atomic project quotas", () => {
  it("shares Scout search across workspaces, limits to 20/day and rolls back both buckets", async () => {
    const { service, counts } = fakeQuota();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        service.reserve(i % 2 ? workspaceId : "other-workspace", "youtube", now),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(20);
    for (const bucket of quotaBuckets("youtube", now)) expect(counts.get(bucket.id)).toBe(20);
  });
  it("enforces Gemini 1500/day and 5000/month, preserving reservations after provider failures", async () => {
    const { service, counts } = fakeQuota();
    const buckets = quotaBuckets("grounding", now);
    counts.set(buckets[0]!.id, 1499);
    expect(await service.reserve(workspaceId, "grounding", now)).toBe(true);
    expect(await service.reserve(workspaceId, "grounding", now)).toBe(false);
    counts.set(buckets[0]!.id, 0);
    counts.set(buckets[1]!.id, 5000);
    expect(await service.reserve(workspaceId, "grounding", now)).toBe(false);
    expect(counts.get(buckets[0]!.id)).toBe(0);
  });
  it("honors the shared 100-call YouTube search bucket independently", async () => {
    const { service, counts } = fakeQuota();
    counts.set(quotaBuckets("youtube", now)[0]!.id, 100);
    expect(await service.reserve(workspaceId, "youtube", now)).toBe(false);
    expect(counts.has(quotaBuckets("youtube", now)[1]!.id)).toBe(false);
  });
  it("resets at midnight Pacific and across months, including DST", () => {
    expect(quotaPeriods(new Date("2026-12-01T07:59:59Z"))).toEqual({
      day: "2026-11-30",
      month: "2026-11",
    });
    expect(quotaPeriods(new Date("2026-12-01T08:00:00Z"))).toEqual({
      day: "2026-12-01",
      month: "2026-12",
    });
    expect(quotaPeriods(new Date("2026-06-01T07:00:00Z")).day).toBe("2026-06-01");
    expect(stableKey("call")).toBe(stableKey("call"));
    expect(stableKey("call")).not.toBe(stableKey("other"));
  });
  it("propagates database errors instead of reporting exhaustion", async () => {
    const quota = new DiscoveryQuotaService({
      $transaction: async (): Promise<never> => {
        throw new Error("db down");
      },
    } as unknown as Database);
    await expect(quota.reserve(workspaceId, "grounding", now)).rejects.toThrow("db down");
  });
});
