import { describe, expect, it, vi } from "vitest";
import { DiscoveryLearningSource } from "./discovery-learning-source.js";
import {
  briefFixture,
  candidateFixture,
  context,
  channelId,
  now,
} from "../idea/discovery/discovery.fixture.js";
import { initialLearning, rankCandidates } from "../idea/discovery/scoring.js";

const id = "66666666-6666-4666-8666-666666666666";
function fixture(): {
  source: DiscoveryLearningSource;
  db: {
    analyticsMetricSnapshot: { findMany: ReturnType<typeof vi.fn> };
    discoveryRecord: { findMany: ReturnType<typeof vi.fn> };
  };
  publishing: {
    listPublishedRecords: ReturnType<typeof vi.fn>;
    listPublishedPostContexts: ReturnType<typeof vi.fn>;
  };
  rows: Record<string, unknown>[];
} {
  const base = {
    socialAccountId: "account",
    remoteEntityId: "video",
    periodStart: new Date("2026-11-15"),
    periodEnd: new Date("2026-11-15"),
    availability: "AVAILABLE",
    completeness: "COMPLETE",
  };
  const rows = [
    { ...base, id, definition: { key: "views" }, value: 100 },
    {
      ...base,
      id: "77777777-7777-4777-8777-777777777777",
      definition: { key: "estimatedMinutesWatched" },
      value: 50,
    },
    {
      ...base,
      id: "88888888-8888-4888-8888-888888888888",
      definition: { key: "views" },
      value: 200,
    },
  ];
  const db = {
    analyticsMetricSnapshot: { findMany: vi.fn().mockResolvedValue(rows) },
    discoveryRecord: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            document: [
              {
                ...rankCandidates(
                  [candidateFixture()],
                  briefFixture(),
                  [],
                  initialLearning(briefFixture()),
                  now,
                )[0],
                id,
              },
            ],
          },
        ]),
    },
  };
  const publishing = {
    listPublishedRecords: vi
      .fn()
      .mockResolvedValue([
        {
          channelId,
          platform: "YOUTUBE",
          accountId: "account",
          scheduledPostId: id,
          platformPostId: "video",
        },
      ]),
    listPublishedPostContexts: vi
      .fn()
      .mockResolvedValue([
        { scheduledPostId: id, topic: candidateFixture().topic, durationSeconds: 60 },
      ]),
  };
  return {
    source: new DiscoveryLearningSource(db as never, publishing as never),
    db,
    publishing,
    rows,
  };
}
describe("V10 M14 retention learning source", () => {
  it("joins own published Shorts to ranked factors and latest complete paired view/watch snapshots", async () => {
    const { source, db } = fixture();
    const samples = await source.samples(context, channelId, now);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.retention).toBe(0.5);
    expect(samples[0]?.evidenceSnapshotIds).toEqual([id, "77777777-7777-4777-8777-777777777777"]);
    expect(source.sources(samples)[0]).toMatchObject({
      kind: "ANALYTICS",
      url: "https://www.youtube.com/watch?v=video",
    });
    expect(db.analyticsMetricSnapshot.findMany.mock.calls[0]?.[0].where).toMatchObject({
      workspaceId: context.workspaceId,
      channelId,
    });
  });
  it("never converts unavailable, partial, mismatched, unjoined or zero-view rows into learning", async () => {
    const { source, db, publishing, rows } = fixture();
    rows[0]!.availability = "UNAVAILABLE";
    rows.pop();
    expect(await source.samples(context, channelId, now)).toEqual([]);
    rows[0]!.availability = "AVAILABLE";
    rows[0]!.value = 0;
    expect(await source.samples(context, channelId, now)).toEqual([]);
    rows[0]!.value = 100;
    rows[1]!.periodStart = new Date("2026-11-14");
    expect(await source.samples(context, channelId, now)).toEqual([]);
    rows[1]!.periodStart = new Date("2026-11-15");
    rows[1]!.completeness = "PARTIAL";
    expect(await source.samples(context, channelId, now)).toEqual([]);
    publishing.listPublishedPostContexts.mockResolvedValue([
      { scheduledPostId: id, topic: "other", durationSeconds: 60 },
    ]);
    expect(await source.samples(context, channelId, now)).toEqual([]);
    db.discoveryRecord.findMany.mockResolvedValue([]);
    expect(await source.samples(context, channelId, now)).toEqual([]);
    publishing.listPublishedRecords.mockResolvedValue([
      { channelId: "other", platform: "YOUTUBE" },
    ]);
    expect(await source.samples(context, channelId, now)).toEqual([]);
  });
  it("paginates the publishing port with its supported 100-record limit", async () => {
    const { source, publishing } = fixture();
    publishing.listPublishedRecords
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => ({
          channelId: "other",
          destinationId: `d${i}`,
          publishedAt: "2026-11-15T00:00:00Z",
        })),
      )
      .mockResolvedValueOnce([]);
    expect(await source.samples(context, channelId, now)).toEqual([]);
    expect(publishing.listPublishedRecords).toHaveBeenNthCalledWith(
      2,
      context,
      "2026-11-15T00:00:00Z",
      100,
      "d99",
    );
  });
});
