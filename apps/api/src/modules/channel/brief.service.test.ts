import { describe, expect, it } from "vitest";
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
function failingDatabase(error: unknown): Database {
  return {
    channel: { findFirst: async () => ({ id: "channel" }) },
    $extends: () => ({
      channelBrief: {
        findFirst: async () => null,
        create: async (): Promise<never> => {
          throw error;
        },
      },
    }),
  } as unknown as Database;
}
describe("Brief append failures", () => {
  it("reports concurrent append conflicts without mutating an existing version", async () => {
    const service = new BriefService(failingDatabase({ code: "P2002" }), {
      count: async (): Promise<number> => 0,
    });
    await expect(
      service.create(context, "22222222-2222-4222-8222-222222222222", input),
    ).rejects.toThrow("Brief changed");
  });
  it.each([new Error("storage unavailable"), null])(
    "propagates storage failures",
    async (error) => {
      const service = new BriefService(failingDatabase(error), {
        count: async (): Promise<number> => 0,
      });
      await expect(
        service.create(context, "22222222-2222-4222-8222-222222222222", input),
      ).rejects.toBe(error);
    },
  );
});
