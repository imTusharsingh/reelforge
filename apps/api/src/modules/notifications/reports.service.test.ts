import type { LatestMetricSnapshot } from "@reelforge/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATIONS_CONFIG } from "./notifications.ports.js";
import { reportPeriod } from "./reports.periods.js";
import { ChannelReportsService } from "./reports.service.js";

const workspaceId = "4f8f5a52-62b5-4a43-9a8b-6f0a3f7f1c11";
const channelId = "1b0c4b7e-8f0e-4f9f-a2c4-3a0f5d6e7b8c";
const accountId = "7d4b1d0e-2a8c-4f5e-9b1a-0c2d3e4f5a6b";
const channel = {
  id: channelId,
  workspaceId,
  name: "Fixture",
  status: "ACTIVE" as const,
  timezone: "America/New_York",
};

function snapshot(key: string, day: string, value: number | null): LatestMetricSnapshot {
  return {
    id: crypto.randomUUID(),
    key: key as LatestMetricSnapshot["key"],
    value,
    unit: "COUNT",
    entityGranularity: "CHANNEL",
    remoteEntityId: null,
    periodStart: day,
    periodEnd: day,
    collectedAt: `${day}T12:00:00.000Z`,
    sourceApi: "fixture",
    completeness: "COMPLETE",
    availability: value === null ? "UNAVAILABLE" : "AVAILABLE",
    unavailableReason: value === null ? "not reported" : null,
  };
}

type InsightsQuery = Readonly<{
  channelId: string;
  from: Date;
  to: Date;
  reportLimit: number;
  recommendationLimit: number;
}>;

function failureRow(index: number): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    payload: { postId: crypto.randomUUID(), failureCode: "X" },
    occurredAt: new Date(Date.UTC(2026, 9, 27, 0, 0, index)),
  };
}

function service(options: {
  snapshots?: LatestMetricSnapshot[];
  published?: unknown[];
  failRuns?: boolean;
  failures?: { rows: number; total: number };
  insights?: { reports: number; reportTotal: number; recs: number; recTotal: number };
  insightQueries?: InsightsQuery[];
}): ChannelReportsService {
  const db = {
    outboxEvent: {
      findMany: async (args: { take: number }): Promise<unknown[]> =>
        Array.from({ length: Math.min(options.failures?.rows ?? 0, args.take) }, (_, index) =>
          failureRow(index),
        ),
      count: async (): Promise<number> => options.failures?.total ?? 0,
    },
  };
  const insights = options.insights ?? { reports: 0, reportTotal: 0, recs: 0, recTotal: 0 };
  return new ChannelReportsService(
    db as never,
    {} as never,
    { listPublishedRecords: async () => options.published ?? [] } as never,
    {
      list: async () => [
        { id: accountId, channelId, platform: "YOUTUBE" },
        { id: crypto.randomUUID(), channelId: crypto.randomUUID(), platform: "YOUTUBE" },
      ],
    } as never,
    { listLatestSnapshots: async () => options.snapshots ?? [] } as never,
    {
      listChannelInsightsBetween: async (_context: unknown, query: InsightsQuery) => {
        options.insightQueries?.push(query);
        return {
          reports: Array.from({ length: Math.min(insights.reports, query.reportLimit) }, () => ({
            id: crypto.randomUUID(),
            status: "GENERATED",
            createdAt: "2026-10-27T00:00:00.000Z",
          })),
          reportTotal: insights.reportTotal,
          recommendations: Array.from(
            { length: Math.min(insights.recs, query.recommendationLimit) },
            () => ({
              id: crypto.randomUUID(),
              action: "post earlier",
              confidence: "LOW",
              status: "PROPOSED",
              createdAt: "2026-10-27T00:00:00.000Z",
            }),
          ),
          recommendationTotal: insights.recTotal,
        };
      },
    } as never,
    {
      countRunOutcomes: async () => {
        if (options.failRuns) throw new Error("db down");
        return { byState: { SUCCEEDED: 2, FAILED: 1 }, failedRunIds: [channelId] };
      },
    } as never,
    {} as never,
    () => new Date("2026-11-10T00:00:00.000Z"),
    DEFAULT_NOTIFICATIONS_CONFIG,
  );
}

describe("M17 report assembly", () => {
  const week = reportPeriod("WEEKLY", "2026-10-26", "America/New_York");

  it("reports a total only when every day has a persisted value and marks gaps", async () => {
    const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
    const snapshots = [
      ...[...days, "2026-10-31", "2026-11-01"].map((day) => snapshot("likes", day, 2)),
      ...days.map((day) => snapshot("views", day, 10)),
      snapshot("views", "2026-10-31", null),
    ];
    const { data, missingData } = await service({ snapshots }).assemble(channel, week);
    const account = data.metrics.accounts[0]!;
    expect(data.metrics.accounts).toHaveLength(1);
    expect(account.totals["likes"]).toBe(14);
    expect(account.totals["views"]).toBeNull();
    expect(data.metrics.status).toBe("PARTIAL");
    expect(missingData.map((item) => item.code)).toContain("INCOMPLETE_METRIC_SNAPSHOTS");
    expect(data.workflow).toMatchObject({ status: "AVAILABLE", completedRuns: 3 });
  });

  it("marks sources with no data as unavailable instead of inventing numbers", async () => {
    const { data, missingData } = await service({ failRuns: true }).assemble(channel, week);
    expect(data.metrics.status).toBe("UNAVAILABLE");
    expect(data.metrics.accounts[0]?.totals).toEqual({});
    expect(data.workflow).toMatchObject({ status: "UNAVAILABLE", completedRuns: 0 });
    expect(missingData.map((item) => item.code)).toEqual(
      expect.arrayContaining(["NO_METRIC_SNAPSHOTS", "RUN_OUTCOMES_UNAVAILABLE"]),
    );
  });

  it("keeps only published records of this channel inside the local period", async () => {
    const record = (publishedAt: string, channel = channelId): Record<string, string> => ({
      workspaceId,
      channelId: channel,
      scheduledPostId: crypto.randomUUID(),
      destinationId: crypto.randomUUID(),
      accountId,
      platform: "YOUTUBE",
      platformPostId: "yt",
      publishedAt,
    });
    const published = [
      record("2026-10-26T04:30:00.000Z"), // 00:30 local on the first day
      record("2026-10-27T12:00:00.000Z", crypto.randomUUID()),
      record("2026-11-02T04:59:00.000Z"), // 23:59 local on the last day (EST)
      record("2026-11-02T05:00:00.000Z"), // next week
    ];
    const { data } = await service({ published }).assemble(channel, week);
    expect(data.publishing.publishedCount).toBe(2);
    expect(data.publishing.status).toBe("AVAILABLE");
  });

  const codes = (items: ReadonlyArray<{ code: string }>): string[] =>
    items.map((item) => item.code);

  it("reports the exact publish-failure count and marks a capped failure list PARTIAL", async () => {
    const capped = await service({ failures: { rows: 250, total: 250 } }).assemble(channel, week);
    expect(capped.data.publishing.failedCount).toBe(250);
    expect(capped.data.publishing.failures).toHaveLength(200);
    expect(capped.data.publishing.status).toBe("PARTIAL");
    expect(codes(capped.missingData)).toContain("PUBLISH_FAILURES_TRUNCATED");

    const whole = await service({ failures: { rows: 3, total: 3 } }).assemble(channel, week);
    expect(whole.data.publishing.failedCount).toBe(3);
    expect(whole.data.publishing.failures).toHaveLength(3);
    expect(codes(whole.missingData)).not.toContain("PUBLISH_FAILURES_TRUNCATED");
  });

  it("reads insights bounded to the period and marks capped insight reports PARTIAL", async () => {
    const insightQueries: InsightsQuery[] = [];
    const { data, missingData } = await service({
      insights: { reports: 60, reportTotal: 60, recs: 2, recTotal: 2 },
      insightQueries,
    }).assemble(channel, week);
    expect(insightQueries).toEqual([
      {
        channelId,
        from: week.start,
        to: week.end,
        reportLimit: 50,
        recommendationLimit: 100,
      },
    ]);
    expect(data.insights.status).toBe("PARTIAL");
    expect(data.insights.reportCount).toBe(60);
    expect(data.insights.reports).toHaveLength(50);
    expect(data.insights.recommendationCount).toBe(2);
    expect(codes(missingData)).toContain("INSIGHT_REPORTS_TRUNCATED");
    expect(codes(missingData)).not.toContain("RECOMMENDATIONS_TRUNCATED");
  });

  it("marks capped recommendations PARTIAL with the exact total", async () => {
    const { data, missingData } = await service({
      insights: { reports: 1, reportTotal: 1, recs: 120, recTotal: 120 },
    }).assemble(channel, week);
    expect(data.insights.status).toBe("PARTIAL");
    expect(data.insights.recommendationCount).toBe(120);
    expect(data.insights.recommendations).toHaveLength(100);
    expect(codes(missingData)).toContain("RECOMMENDATIONS_TRUNCATED");
    expect(codes(missingData)).not.toContain("INSIGHT_REPORTS_TRUNCATED");

    const none = await service({}).assemble(channel, week);
    expect(none.data.insights).toMatchObject({
      status: "NO_DATA",
      reportCount: 0,
      recommendationCount: 0,
    });
  });
});
