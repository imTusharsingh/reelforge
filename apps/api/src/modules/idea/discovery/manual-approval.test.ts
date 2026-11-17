import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeaService } from "../idea.service.js";
import { briefFixture, context, channelId, now } from "./discovery.fixture.js";

function fixture(): {
  service: IdeaService;
  db: {
    idea: Record<string, ReturnType<typeof vi.fn>>;
    ideaApprovalSnapshot: Record<string, ReturnType<typeof vi.fn>>;
    $extends: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  brief: ReturnType<typeof briefFixture>;
} {
  const brief = briefFixture();
  const row = {
    id: "idea",
    workspaceId: context.workspaceId,
    channelId,
    seriesId: null,
    status: "DRAFT",
    archivedAt: null,
    updatedAt: now,
    topic: "tides",
    hook: "Why oceans rise",
    angle: "Physics",
    audience: "Adults",
    references: [],
    sourceNotes: null,
    expectedFormat: "explainer",
    modelVersion: null,
    promptVersion: null,
    cost: null,
    costCurrency: null,
  };
  const db = {
    idea: {
      findUnique: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
    },
    ideaApprovalSnapshot: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    $extends: vi.fn(() => ({
      channelBrief: { findFirst: async (): Promise<unknown> => ({ document: brief }) },
    })),
    $transaction: vi.fn(async (action: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
      action(db),
    ),
  };
  return { service: new IdeaService(db as never, {} as never), db, brief };
}
afterEach(() => vi.unstubAllEnvs());
describe("V10 L1-only manual idea approval", () => {
  it("rejects manual approval at L2/L3 before writes", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    const { service, db, brief } = fixture();
    for (const level of ["L2", "L3"] as const) {
      brief.requestedAutonomy = level;
      await expect(service.transition(context, "idea", "APPROVED", now, "DRAFT")).rejects.toThrow(
        "only at L1",
      );
    }
    expect(db.idea.updateMany).not.toHaveBeenCalled();
    expect(db.ideaApprovalSnapshot.create).not.toHaveBeenCalled();
  });
  it("retains immutable approval snapshots at L1 and legacy behavior with v2 disabled", async () => {
    const { service, db, brief } = fixture();
    vi.stubEnv("PIPELINE_V2", "true");
    brief.requestedAutonomy = "L1";
    await service.transition(context, "idea", "APPROVED", now, "DRAFT");
    expect(db.ideaApprovalSnapshot.create).toHaveBeenCalledOnce();
    vi.stubEnv("PIPELINE_V2", "false");
    brief.requestedAutonomy = "L2";
    await service.transition(context, "idea", "APPROVED", now, "DRAFT");
    expect(db.ideaApprovalSnapshot.create).toHaveBeenCalledTimes(2);
  });
});
