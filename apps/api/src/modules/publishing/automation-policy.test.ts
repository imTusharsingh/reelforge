import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foundationWorkspaceGuard, type PrismaClient, type Prisma } from "@reelforge/database";
import { AutomationPolicy } from "./automation-policy.js";
import { context, id } from "./automation.fixture.js";
vi.mock("@reelforge/database", async (original) => ({
  ...(await original<typeof import("@reelforge/database")>()),
  foundationWorkspaceGuard: vi.fn((db: { foundation: unknown }) => db.foundation),
}));
beforeEach(() => {
  vi.stubEnv("PIPELINE_V2", "true");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T09:00:00Z"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function fixture(): { policy: AutomationPolicy; db: ReturnType<typeof fakeDb> } {
  const db = fakeDb();
  return { policy: new AutomationPolicy(db as unknown as PrismaClient), db };
}
function fakeDb(): {
  publishingDestination: { findFirst: ReturnType<typeof vi.fn> };
  v9PublishSlot: { findFirst: ReturnType<typeof vi.fn> };
  v9InsertLease: {
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  foundation: {
    videoRun: { findFirst: ReturnType<typeof vi.fn> };
    runEvent: { findFirst: ReturnType<typeof vi.fn> };
    budgetEnvelope: { findFirst: ReturnType<typeof vi.fn> };
  };
  $queryRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
} {
  const db = {
    publishingDestination: { findFirst: vi.fn(async () => ({ scheduledPostId: id(10) })) },
    v9PublishSlot: { findFirst: vi.fn(async () => ({ id: id(7), runId: id(3) })) },
    v9InsertLease: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: id(20) })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    foundation: {
      videoRun: {
        findFirst: vi.fn(async () => ({
          state: "SCHEDULED",
          pauseReason: null,
          effectiveAutonomy: "L2",
          approvedShortsAtStart: 0,
        })),
      },
      runEvent: { findFirst: vi.fn(async () => ({ type: "approved" })) },
      budgetEnvelope: {
        findFirst: vi.fn(async () => ({ spentMinor: 579, reservedMinor: 0, hardCapMinor: 800 })),
      },
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(
    async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(db as unknown as Prisma.TransactionClient),
  );
  return db;
}
const policyContext = {
  workspaceId: context.workspaceId,
  channelId: id(4),
  scheduledAt: new Date("2027-03-14T07:00:00Z"),
  platform: "YOUTUBE" as const,
  destinationId: id(11),
  idempotencyKey: id(11),
};
describe("V9 project-wide insert leases and hard policy", () => {
  it("reserves at 99, blocks 100, serializes project/day and records Pacific date", async () => {
    const f = fixture();
    f.db.v9InsertLease.count.mockResolvedValue(99);
    const reservation = await f.policy.reserve(policyContext);
    expect(reservation.reservationId).toContain(context.workspaceId);
    expect(f.db.$queryRaw).toHaveBeenCalled();
    expect(f.db.v9InsertLease.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quotaDay: "2026-11-17", workspaceId: context.workspaceId }),
      }),
    );
    f.db.v9InsertLease.count.mockResolvedValue(100);
    await expect(f.policy.reserve(policyContext)).rejects.toThrow("QUOTA");
  });
  it("reuses a consumed lease for recovery, never refunds uncertain dispatch", async () => {
    const f = fixture();
    f.db.v9InsertLease.findFirst.mockResolvedValue({
      id: id(20),
      status: "DISPATCHED",
      quotaDay: "2026-11-16",
    });
    const reservation = await f.policy.reserve(policyContext);
    expect(f.db.v9InsertLease.create).not.toHaveBeenCalled();
    await f.policy.release(reservation);
    expect(f.db.v9InsertLease.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: context.workspaceId, id: id(20), status: "DISPATCHED" },
      data: { status: "CONSUMED" },
    });
  });
  it("rebooks a reserved lease into the actual dispatch day", async () => {
    const f = fixture();
    f.db.v9InsertLease.findFirst.mockResolvedValue({
      id: id(20),
      status: "RESERVED",
      quotaDay: "2026-11-16",
    });
    await f.policy.reserve(policyContext);
    expect(f.db.v9InsertLease.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quotaDay: "2026-11-17" }) }),
    );
  });
  it("requires workspace-bound run approval, first-ten gating and budget", async () => {
    const f = fixture();
    expect((await f.policy.check(policyContext)).allowed).toBe(true);
    expect(foundationWorkspaceGuard).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining({ workspaceId: context.workspaceId, role: "VIEWER" }),
    );
    f.db.foundation.runEvent.findFirst.mockResolvedValue({ type: "auto_approved" });
    expect((await f.policy.check(policyContext)).allowed).toBe(false);
    f.db.foundation.videoRun.findFirst.mockResolvedValue({
      state: "SCHEDULED",
      pauseReason: null,
      effectiveAutonomy: "L3",
      approvedShortsAtStart: 10,
    });
    expect((await f.policy.check(policyContext)).allowed).toBe(true);
    f.db.foundation.budgetEnvelope.findFirst.mockResolvedValue({
      spentMinor: 801,
      reservedMinor: 0,
      hardCapMinor: 800,
    });
    expect((await f.policy.check(policyContext)).allowed).toBe(false);
    vi.stubEnv("PIPELINE_V2", "false");
    expect((await f.policy.check(policyContext)).allowed).toBe(false);
  });
});
