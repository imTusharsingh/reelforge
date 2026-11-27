import { describe, expect, it, vi } from "vitest";
import { defaultBrief } from "@reelforge/contracts";
import type { Database } from "../identity/identity.types.js";
import { BriefService } from "./brief.service.js";
const context = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "user",
  role: "OWNER" as const,
};
const input = defaultBrief({
  niche: "Science",
  audience: "Adults",
  language: "English",
  voiceId: "Kore",
  cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
});
function failingDatabase(error: unknown): {
  db: Database;
  create: ReturnType<typeof vi.fn<() => Promise<never>>>;
  update: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (): Promise<never> => {
    throw error;
  });
  const update = vi.fn();
  const tx = { channelBrief: { create }, channel: { update } };
  const reads = { channelBrief: { findFirst: async (): Promise<null> => null } };
  const db = {
    channel: { findFirst: async (): Promise<{ id: string }> => ({ id: "channel" }) },
    $extends: (): typeof reads => reads,
    $transaction: <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  };
  return { db: db as unknown as Database, create, update };
}
describe("Brief append failures", () => {
  it("reports concurrent append conflicts without mutating an existing version", async () => {
    const { db, create, update } = failingDatabase({ code: "P2002" });
    const service = new BriefService(db, {
      count: async (): Promise<number> => 0,
    });
    await expect(
      service.create(context, "22222222-2222-4222-8222-222222222222", input),
    ).rejects.toThrow("Brief changed");
    expect(create).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
  it.each([new Error("storage unavailable"), null])(
    "propagates storage failures",
    async (error) => {
      const service = new BriefService(failingDatabase(error).db, {
        count: async (): Promise<number> => 0,
      });
      await expect(
        service.create(context, "22222222-2222-4222-8222-222222222222", input),
      ).rejects.toBe(error);
    },
  );
});
