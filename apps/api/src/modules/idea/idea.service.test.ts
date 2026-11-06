import { ConflictException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { IdeaService } from "./idea.service.js";

const context = { workspaceId: "workspace-a", userId: "user-a", role: "OWNER" as const };
const input = {
  title: "  Morning  habits! ",
  topic: "habits",
  hook: "A useful hook",
  angle: "practical",
  audience: "students",
  references: [],
  sourceNotes: "",
  expectedFormat: "short",
  channelId: "channel-a",
  seriesId: undefined,
};

type Mock = ReturnType<typeof vi.fn>;
function database(): {
  idea: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock; updateMany: Mock };
  channel: { findUnique: Mock };
  contentSeries: { findUnique: Mock };
  ideaApprovalSnapshot: { findUnique: Mock; create: Mock };
  $transaction: Mock;
} {
  const fake = {
    idea: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi
        .fn()
        .mockImplementation(async ({ data }: { data: { normalizedTitle: string } }) => ({
          id: "idea-a",
          ...data,
        })),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    channel: { findUnique: vi.fn().mockResolvedValue({ id: "channel-a" }) },
    contentSeries: { findUnique: vi.fn() },
    ideaApprovalSnapshot: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: typeof fake) => Promise<unknown>) => callback(fake)),
  };
  return fake;
}

describe("IdeaService", () => {
  it("normalizes titles and records duplicate candidates instead of dropping them", async () => {
    const db = database();
    db.idea.findMany.mockResolvedValue([
      { id: "prior", title: "Morning habits", normalizedTitle: "morning habits", topic: "habits" },
    ]);
    const created = new IdeaService(db as never, { proposeIdea: vi.fn() });
    const result = await created.create(context, input, "USER");
    expect(result).toMatchObject({ normalizedTitle: "morning habits" });
    expect(db.idea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          duplicateMatches: {
            create: [expect.objectContaining({ reason: "exact normalized title" })],
          },
        }),
      }),
    );
  });

  it("rejects viewers and invalid lifecycle transitions", async () => {
    const db = database();
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(
      service.create({ ...context, role: "VIEWER" }, input, "USER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    db.idea.findUnique.mockResolvedValue({
      id: "idea-a",
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "new",
    });
    await expect(
      service.transition(context, "idea-a", "SCHEDULED", new Date()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("enforces cooldown before approval", async () => {
    const db = database();
    db.idea.findUnique.mockResolvedValue({
      id: "idea-a",
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "habits",
    });
    db.idea.findMany.mockResolvedValue([{ topic: "Habits" }]);
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(service.transition(context, "idea-a", "APPROVED")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects a foreign channel and mismatched series channel", async () => {
    const db = database();
    db.channel.findUnique.mockResolvedValue(null);
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(service.create(context, input, "USER")).rejects.toThrow("Channel not found");
    db.channel.findUnique.mockResolvedValue({ id: "channel-a" });
    db.contentSeries.findUnique.mockResolvedValue({ id: "series-a", channelId: "channel-b" });
    await expect(
      service.create(context, { ...input, seriesId: "series-a" }, "USER"),
    ).rejects.toThrow("must match");
  });

  it("creates an immutable approval snapshot and allows diversity when the window is varied", async () => {
    const db = database();
    db.idea.findUnique.mockResolvedValue({
      id: "idea-a",
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "habits",
      hook: "h",
      angle: "a",
      audience: "u",
      references: [],
      sourceNotes: "",
      expectedFormat: "short",
      modelVersion: null,
      promptVersion: null,
      cost: null,
      costCurrency: null,
      workspaceId: "workspace-a",
    });
    db.idea.findMany.mockResolvedValue([{ topic: "travel" }, { topic: "science" }]);
    db.ideaApprovalSnapshot.create.mockImplementation(
      async ({ data }: { data: { checksumSha256: string } }) => data,
    );
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    const result = await service.transition(context, "idea-a", "APPROVED");
    expect(result).toMatchObject({ approvalSnapshot: { checksumSha256: expect.any(String) } });
    expect(db.ideaApprovalSnapshot.create).toHaveBeenCalledOnce();
  });

  it("validates an AI fixture through the same input boundary and records provenance", async () => {
    const db = database();
    db.idea.findMany.mockResolvedValue([]);
    const llm = {
      proposeIdea: vi.fn().mockResolvedValue({
        proposal: {
          title: "AI idea",
          topic: "science",
          hook: "hook",
          angle: "angle",
          audience: "students",
          references: [],
          sourceNotes: "fixture",
          expectedFormat: "short",
        },
        metadata: { modelVersion: "fixture-model", promptVersion: "prompt-1", cost: null },
      }),
    };
    const service = new IdeaService(db as never, llm);
    await service.propose(context, {
      prompt: "suggest",
      channelId: "00000000-0000-4000-8000-000000000001",
    });
    expect(db.idea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modelVersion: "fixture-model", cost: null }),
      }),
    );
  });

  it("does not fabricate AI proposals when no adapter is configured", async () => {
    const service = new IdeaService(database() as never, {
      proposeIdea: async (): Promise<never> => {
        throw new Error("not configured");
      },
    });
    await expect(
      service.propose(context, { prompt: "suggest a topic", channelId: "channel-a" }),
    ).rejects.toThrow("not configured");
  });
});
