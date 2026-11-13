import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import type { IdeaProposalLlmPort } from "@reelforge/ai-providers";
import { describe, expect, it, vi } from "vitest";
import { IdeaService } from "./idea.service.js";

const observedAt = new Date("2026-11-11T10:00:00.000Z");
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
  idea: {
    findMany: Mock;
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    create: Mock;
    update: Mock;
    updateMany: Mock;
  };
  channel: { findUnique: Mock };
  contentSeries: { findUnique: Mock };
  ideaApprovalSnapshot: { findUnique: Mock; create: Mock };
  providerRequest: { create: Mock; update: Mock };
  $transaction: Mock;
} {
  const fake = {
    idea: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "idea-a", status: "REJECTED" }),
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
    providerRequest: { create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: typeof fake) => Promise<unknown>) => callback(fake)),
  };
  return fake;
}

function paidUsage(): { reservePaidCall: Mock; finishPaidCall: Mock } {
  return {
    reservePaidCall: vi.fn().mockResolvedValue({
      workspaceId: context.workspaceId,
      reservationId: "reservation-a",
      currency: "USD",
      estimateMinor: 1,
    }),
    finishPaidCall: vi.fn().mockResolvedValue(undefined),
  };
}

function configuredIdeaLlm(llm: {
  proposeIdea: Mock;
}): IdeaProposalLlmPort & { capability: unknown } {
  return {
    proposeIdea: llm.proposeIdea as IdeaProposalLlmPort["proposeIdea"],
    capability: {
      providerId: "fixture",
      capabilityId: "idea-proposal",
      kind: "llm",
      costModel: { currency: "USD", unit: "request", amount: 0.01 },
    },
  };
}

describe("IdeaService", () => {
  it("rejects stale status/timestamp tokens and prevents any conditional mutation", async () => {
    const db = database();
    db.idea.findUnique.mockResolvedValue({
      id: "idea-a",
      workspaceId: "workspace-a",
      updatedAt: observedAt,
      status: "DRAFT",
      archivedAt: null,
      channelId: "channel-a",
      seriesId: null,
      topic: "test",
    });
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(
      service.transition(context, "idea-a", "BACKLOG", observedAt, "APPROVED"),
    ).rejects.toThrow("Idea changed");
    await expect(
      service.transition(context, "idea-a", "BACKLOG", new Date(observedAt.getTime() - 1), "DRAFT"),
    ).rejects.toThrow("Idea changed");
    expect(db.idea.updateMany).not.toHaveBeenCalled();
    db.idea.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.transition(context, "idea-a", "BACKLOG", observedAt, "DRAFT"),
    ).rejects.toThrow("Idea changed");
    expect(db.idea.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-a",
          id: "idea-a",
          status: "DRAFT",
          updatedAt: observedAt,
          archivedAt: null,
        }),
      }),
    );
    expect(db.idea.update).not.toHaveBeenCalled();
  });

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
      updatedAt: observedAt,
      id: "idea-a",
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "new",
    });
    await expect(
      service.transition(context, "idea-a", "SCHEDULED", observedAt, "DRAFT", new Date()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("enforces cooldown before approval", async () => {
    const db = database();
    db.idea.findUnique.mockResolvedValue({
      updatedAt: observedAt,
      id: "idea-a",
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "habits",
    });
    db.idea.findMany.mockResolvedValue([{ topic: "Habits" }]);
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(
      service.transition(context, "idea-a", "APPROVED", observedAt, "DRAFT"),
    ).rejects.toBeInstanceOf(ConflictException);
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
      updatedAt: observedAt,
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
    let persisted: Record<string, unknown> | undefined;
    db.ideaApprovalSnapshot.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        persisted = data;
        return data;
      },
    );
    db.ideaApprovalSnapshot.findUnique.mockImplementation(async () => persisted);
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    const result = await service.transition(context, "idea-a", "APPROVED", observedAt, "DRAFT");
    expect(result).toMatchObject({ approvalSnapshot: { checksumSha256: expect.any(String) } });
    expect(db.ideaApprovalSnapshot.create).toHaveBeenCalledOnce();
    const original = { ...persisted };
    db.idea.findUnique.mockResolvedValue({
      updatedAt: observedAt,
      id: "idea-a",
      status: "APPROVED",
      channelId: "channel-a",
      seriesId: null,
      topic: "habits",
      hook: "changed",
      angle: "changed",
      audience: "changed",
      references: ["changed"],
      sourceNotes: "changed",
      expectedFormat: "changed",
      modelVersion: "changed",
      promptVersion: "changed",
      cost: 99,
      costCurrency: "USD",
      workspaceId: "workspace-a",
    });
    await service.transition(
      context,
      "idea-a",
      "SCHEDULED",
      observedAt,
      "APPROVED",
      new Date(Date.now() + 60_000),
    );
    expect(db.ideaApprovalSnapshot.create).toHaveBeenCalledOnce();
    expect(persisted).toEqual(original);
    expect(await service.getApproved(context, "idea-a")).toMatchObject({
      topic: "habits",
      hook: "h",
      checksumSha256: original.checksumSha256,
    });
  });

  it("rejects malformed AI proposals and invalid provenance without persisting", async () => {
    const db = database();
    const service = new IdeaService(
      db as never,
      configuredIdeaLlm({
        proposeIdea: vi.fn().mockResolvedValue({
          proposal: { title: "bad" },
          metadata: { modelVersion: "m", promptVersion: "p", cost: null },
        }),
      }),
      paidUsage() as never,
    );
    await expect(service.propose(context, { prompt: "suggest" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.idea.create).not.toHaveBeenCalled();
    const invalid = new IdeaService(
      db as never,
      configuredIdeaLlm({
        proposeIdea: vi.fn().mockResolvedValue({
          proposal: { ...input },
          metadata: { modelVersion: "", promptVersion: "p", cost: -1 },
        }),
      }),
      paidUsage() as never,
    );
    await expect(invalid.propose(context, { prompt: "suggest" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.idea.create).not.toHaveBeenCalled();
  });

  it("persists the series channel when channel input is omitted", async () => {
    const db = database();
    db.contentSeries.findUnique.mockResolvedValue({ id: "series-a", channelId: "channel-series" });
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await service.create(context, { ...input, channelId: undefined, seriesId: "series-a" }, "USER");
    expect(db.idea.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channelId: "channel-series" }) }),
    );
  });

  it("enforces independent diversity for channel and series windows", async () => {
    const db = database();
    const idea = {
      id: "idea-a",
      updatedAt: observedAt,
      status: "DRAFT",
      channelId: "channel-a",
      seriesId: null,
      topic: "new",
    };
    db.idea.findUnique.mockResolvedValue(idea);
    db.idea.findMany.mockResolvedValue([{ topic: "one" }, { topic: "one" }, { topic: "one" }]);
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(
      service.transition(context, "idea-a", "APPROVED", observedAt, "DRAFT"),
    ).rejects.toThrow("diversity");
    db.idea.findUnique.mockResolvedValue({ ...idea, seriesId: "series-a" });
    await expect(
      service.transition(context, "idea-a", "APPROVED", observedAt, "DRAFT"),
    ).rejects.toThrow("diversity");
    db.idea.findMany.mockResolvedValue([{ topic: "one" }, { topic: "two" }, { topic: "three" }]);
    db.idea.findUnique.mockResolvedValue({ ...idea, seriesId: "series-a" });
    db.ideaApprovalSnapshot.create.mockResolvedValue({});
    await expect(
      service.transition(context, "idea-a", "APPROVED", observedAt, "DRAFT"),
    ).resolves.toBeDefined();
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
    const service = new IdeaService(db as never, configuredIdeaLlm(llm), paidUsage() as never);
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

  it("reserves before dispatches and charges an estimate when dispatch fails", async () => {
    const db = database();
    const usage = paidUsage();
    const events: string[] = [];
    usage.reservePaidCall.mockImplementation(async () => {
      events.push("reserve");
      return {
        workspaceId: context.workspaceId,
        reservationId: "reservation-a",
        currency: "USD",
        estimateMinor: 1,
      };
    });
    const llm = configuredIdeaLlm({
      proposeIdea: vi.fn().mockImplementation(async () => {
        events.push("dispatch");
        throw new Error("provider failed");
      }),
    });
    const service = new IdeaService(db as never, llm, usage as never);

    await expect(service.propose(context, { prompt: "suggest" })).rejects.toThrow(
      "provider failed",
    );
    expect(events).toEqual(["reserve", "dispatch"]);
    expect(usage.finishPaidCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatched: true, actualCost: null }),
    );
  });

  it.each(["exhausted", "replayed"])("%s refusal never dispatches", async (reason) => {
    const db = database();
    const usage = paidUsage();
    usage.reservePaidCall.mockRejectedValue(new Error(reason));
    const proposeIdea = vi.fn();
    const service = new IdeaService(
      db as never,
      configuredIdeaLlm({ proposeIdea }),
      usage as never,
    );

    await expect(service.propose(context, { prompt: "suggest" })).rejects.toThrow(reason);
    expect(proposeIdea).not.toHaveBeenCalled();
  });

  it("releases a reservation when the pre-dispatch ledger write fails", async () => {
    const db = database();
    db.providerRequest.create.mockRejectedValue(new Error("ledger unavailable"));
    const usage = paidUsage();
    const proposeIdea = vi.fn();
    const service = new IdeaService(
      db as never,
      configuredIdeaLlm({ proposeIdea }),
      usage as never,
    );

    await expect(service.propose(context, { prompt: "suggest" })).rejects.toThrow(
      "ledger unavailable",
    );
    expect(proposeIdea).not.toHaveBeenCalled();
    expect(usage.finishPaidCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatched: false, actualCost: null }),
    );
  });

  it("uses a stable paid-call key so a replay cannot dispatch twice", async () => {
    const db = database();
    db.idea.findMany.mockResolvedValue([]);
    const usage = paidUsage();
    const replay = new Error("PAID_CALL_REPLAYED");
    usage.reservePaidCall.mockResolvedValueOnce({
      workspaceId: context.workspaceId,
      reservationId: "reservation-a",
      currency: "USD",
      estimateMinor: 1,
    });
    usage.reservePaidCall.mockRejectedValueOnce(replay);
    const proposeIdea = vi.fn().mockResolvedValue({
      proposal: {
        title: "AI idea",
        topic: "science",
        hook: "hook",
        angle: "angle",
        audience: "students",
        references: [],
        expectedFormat: "short",
      },
      metadata: { modelVersion: "fixture", promptVersion: "prompt", cost: 0.01 },
    });
    const service = new IdeaService(
      db as never,
      configuredIdeaLlm({ proposeIdea }),
      usage as never,
    );
    const request = {
      prompt: "same request",
      channelId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000002",
    };
    await service.propose(context, request);
    await expect(service.propose(context, request)).rejects.toThrow("PAID_CALL_REPLAYED");
    expect(proposeIdea).toHaveBeenCalledOnce();
  });
});
