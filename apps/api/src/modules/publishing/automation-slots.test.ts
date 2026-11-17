import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { defaultBrief } from "@reelforge/contracts";
import type { Prisma, PrismaClient } from "@reelforge/database";
import { AutomationSlots, type AutoSlot } from "./automation-slots.js";
import { automationFixture, context, id, packaged } from "./automation.fixture.js";
it("reserves only one slot for a run, serializes channel and skips calendar collisions", async () => {
  const f = automationFixture();
  f.run.inputSnapshot = {
    brief: {
      ...defaultBrief({
        niche: "Science",
        audience: "Adults",
        language: "English",
        voiceId: "Kore",
        cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
      }),
      id: id(9),
      workspaceId: context.workspaceId,
      channelId: f.run.channelId,
      schemaVersion: "1.0",
      version: 1,
    },
  };
  let saved: AutoSlot | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    socialAccount: { findFirst: vi.fn(async () => ({ id: id(8) })) },
    v9PublishSlot: {
      findFirst: vi.fn(async () => saved),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: AutoSlot }) => {
        saved = data;
        return data;
      }),
    },
    scheduledPost: {
      findMany: vi.fn(async () => [{ scheduledAt: new Date("2026-11-17T18:00:00Z") }]),
    },
  };
  const db = {
    $transaction: async (
      work: (client: Prisma.TransactionClient) => Promise<unknown>,
    ): Promise<unknown> => work(tx as unknown as Prisma.TransactionClient),
  };
  const slots = new AutomationSlots(db as unknown as PrismaClient);
  const first = await slots.reserve(context, f.run, packaged, new Date("2026-11-17T00:00:00Z"));
  expect(first.scheduledAt.toISOString()).toBe("2026-11-18T18:00:00.000Z");
  expect((await slots.reserve(context, f.run, packaged, new Date("2026-11-17T00:00:00Z"))).id).toBe(
    first.id,
  );
  expect(tx.v9PublishSlot.create).toHaveBeenCalledTimes(1);
  expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
});
describe("V9 immutable brief binding", () => {
  it("refuses cross-channel brief snapshots before any write", async () => {
    const f = automationFixture();
    f.run.inputSnapshot = {};
    const slots = new AutomationSlots({} as PrismaClient);
    await expect(slots.reserve(context, f.run, packaged, new Date())).rejects.toThrow();
  });
});
