import { describe, expect, it, vi } from "vitest";
import { DiscoveryFactors } from "@reelforge/contracts";
import { DiscoveryStore } from "./store.js";
import { initialLearning, rankCandidates } from "./scoring.js";
import { briefFixture, candidateFixture, context, channelId, now } from "./discovery.fixture.js";

type Row = Record<string, unknown>;
function fakeStore(): {
  store: DiscoveryStore;
  records: Row[];
  ideas: Row[];
  snapshots: Row[];
  db: Record<string, unknown>;
} {
  const records: Row[] = [],
    ideas: Row[] = [],
    snapshots: Row[] = [];
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(
      ([key, value]) => key === "createdAt" || key === "OR" || row[key] === value,
    );
  const record = {
    findFirst: vi.fn(
      async ({ where }: { where: Row }): Promise<Row | null> =>
        records.find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Row }): Promise<Row[]> =>
      records.filter((row) => matches(row, where)),
    ),
    create: vi.fn(async ({ data }: { data: Row }): Promise<Row> => {
      records.push(data);
      return data;
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }): Promise<{ count: number }> => {
      const item = data[0]!;
      if (
        records.some((row) =>
          ["workspaceId", "channelId", "kind", "key"].every((key) => row[key] === item[key]),
        )
      )
        return { count: 0 };
      records.push(item);
      return { count: 1 };
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Row; data: Row }): Promise<{ count: number }> => {
        const rows = records.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { workspaceId_channelId_kind_key: Row };
        create: Row;
        update: Row;
      }): Promise<Row> => {
        const row = records.find((item) => matches(item, where.workspaceId_channelId_kind_key));
        if (row) {
          Object.assign(row, update);
          return row;
        }
        records.push(create);
        return create;
      },
    ),
  };
  const db: Record<string, unknown> = {
    channel: {
      findFirst: vi.fn(async ({ where }: { where: Row }): Promise<Row | null> =>
        where.workspaceId === context.workspaceId ? { id: channelId } : null,
      ),
    },
    $extends: (): unknown => ({
      channelBrief: { findFirst: async (): Promise<unknown> => ({ document: briefFixture() }) },
    }),
    discoveryRecord: record,
    idea: {
      findMany: vi.fn(async ({ where }: { where: Row }): Promise<Row[]> =>
        ideas.filter((row) => matches(row, where)),
      ),
      create: vi.fn(async ({ data }: { data: Row }): Promise<Row> => {
        ideas.push(data);
        return data;
      }),
    },
    ideaApprovalSnapshot: {
      create: vi.fn(async ({ data }: { data: Row }): Promise<Row> => {
        snapshots.push(data);
        return data;
      }),
    },
    $executeRaw: vi.fn(async (): Promise<number> => 1),
  };
  db.$transaction = async (action: (client: unknown) => Promise<unknown>): Promise<unknown> =>
    action(db);
  return { store: new DiscoveryStore(db as never), records, ideas, snapshots, db };
}
function ranked(): ReturnType<typeof rankCandidates>[number] & { id: string } {
  return {
    ...rankCandidates(
      [candidateFixture()],
      briefFixture(),
      [],
      initialLearning(briefFixture()),
      now,
    )[0]!,
    id: "66666666-6666-4666-8666-666666666666",
  };
}
describe("V10 tenant-scoped discovery persistence", () => {
  it("claims once, persists sourced ranking and automatically snapshots only the L2 top idea", async () => {
    const { store, records, ideas, snapshots } = fakeStore();
    expect(await store.brief(context, channelId)).toEqual(briefFixture());
    expect(await store.claim(context, channelId, "day", now)).toBe(true);
    expect(await store.claim(context, channelId, "day", now)).toBe(false);
    const second = {
      ...ranked(),
      id: "88888888-8888-4888-8888-888888888888",
      topic: "Why stars glow",
    };
    await store.finish(context, briefFixture(), "day", [ranked(), second], now);
    expect(ideas.map((row) => row.status)).toEqual(["APPROVED", "DRAFT"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.references).toEqual(candidateFixture().sources.map((s) => s.url));
    expect(records.find((row) => row.kind === "TICK")?.document).toEqual({
      status: "SUCCEEDED",
      count: 2,
    });
    await store.finish(context, briefFixture(), "later", [ranked()], now);
    expect(ideas).toHaveLength(2);
    await store.history(context, channelId);
  });
  it("keeps L1 manual approval and never snapshots its discovered drafts", async () => {
    const { store, ideas, snapshots } = fakeStore(),
      brief = briefFixture();
    brief.requestedAutonomy = "L1";
    await store.finish(context, brief, "day", [ranked()], now);
    expect(ideas[0]?.status).toBe("DRAFT");
    expect(snapshots).toHaveLength(0);
  });
  it("rejects foreign channels and viewers; audit reads stay workspace scoped", async () => {
    const { store, records, db } = fakeStore();
    await expect(store.brief({ ...context, workspaceId: "other" }, channelId)).rejects.toThrow(
      "Channel not found",
    );
    await expect(
      store.claim({ ...context, role: "VIEWER" }, channelId, "day", now),
    ).rejects.toThrow("Editor permission");
    await expect(store.assertChannel({ ...context, userId: "" }, channelId)).rejects.toThrow(
      "Verified workspace",
    );
    expect(await store.changes(context, channelId)).toEqual([]);
    records.push({ workspaceId: "other", channelId, kind: "LEARNING", document: { unsafe: true } });
    expect(await store.changes(context, channelId)).toEqual([]);
    (db.channel as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValue({
      id: channelId,
    });
    db.$extends = (): unknown => ({ channelBrief: { findFirst: async (): Promise<null> => null } });
    await expect(store.brief(context, channelId)).rejects.toThrow("Channel Brief not found");
  });
  it("audits applied changes once per week and reuses learned state on later ticks", async () => {
    const { store, records } = fakeStore(),
      brief = briefFixture();
    const before = initialLearning(brief);
    brief.tuningBounds = {
      scoringWeights: Object.fromEntries(DiscoveryFactors.map((key) => [key, { min: 0, max: 1 }])),
      formatMix: Object.fromEntries(
        Object.keys(before.formatMix).map((key) => [key, { min: 0, max: 1 }]),
      ),
    };
    const samples = [0, 1, 2].map((i) => ({
      videoId: `v${i}`,
      formatKey: Object.keys(before.formatMix)[0]!,
      retention: i / 3,
      factors: { ...before.weights, briefFit: i / 3 },
      evidenceSnapshotIds: [ranked().id],
    }));
    expect(await store.learn(context, brief, [], now)).toEqual(before);
    expect(records).toHaveLength(0);
    const state = await store.learn(context, brief, samples, now);
    expect(state.weights.briefFit).toBeGreaterThan(before.weights.briefFit);
    expect(await store.learn(context, brief, samples, now)).toEqual(state);
    expect(records.filter((row) => row.kind === "LEARNING")).toHaveLength(1);
    const changes = await store.changes(context, channelId);
    expect(changes[0]?.mode).toBe("APPLIED");
    expect(changes[0]?.before).toEqual(before);
    await store.learn(context, brief, samples, new Date(now.getTime() + 7 * 86400000));
    expect(records.filter((row) => row.kind === "LEARNING")).toHaveLength(2);
    await store.claim(context, channelId, "failed", now);
    await store.failure(context, channelId, "failed");
    expect(records.find((row) => row.key === "failed")?.document).toMatchObject({
      status: "FAILED",
    });
  });
});
