import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publishedVideoLabel, rankVideos } from "./insights-model";

const source = readFileSync(new URL("./insights-screen.tsx", import.meta.url), "utf8");

describe("M28 insights screen contracts", () => {
  it("ranks top content and uses the required published-date label fallback", () => {
    const rows = [
      {
        id: "a",
        key: "views",
        value: 10,
        remoteEntityId: "low",
        completeness: "COMPLETE",
        availability: "AVAILABLE",
        unavailableReason: null,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-01",
        collectedAt: "2026-11-02T00:00:00.000Z",
        sourceApi: "fixture",
      },
      {
        id: "b",
        key: "views",
        value: 50,
        remoteEntityId: "top",
        completeness: "COMPLETE",
        availability: "AVAILABLE",
        unavailableReason: null,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-01",
        collectedAt: "2026-11-02T00:00:00.000Z",
        sourceApi: "fixture",
      },
    ];
    const ranked = rankVideos(rows, [
      { platformPostId: "top", publishedAt: "2026-11-01T12:00:00.000Z" },
    ]);
    expect(ranked.map((video) => video.id)).toEqual(["top", "low"]);
    expect(ranked[0]?.label).toBe("2026-11-01T12:00:00.000Z · top");
    expect(publishedVideoLabel(undefined, "missing")).toBe("Published date unavailable · missing");
  });
  it("ships all D10 views and real selectors", () => {
    for (const text of [
      "Overview",
      "Videos",
      "Comparisons",
      "Recommendations",
      "Channel",
      "YouTube account",
      'type="date"',
    ])
      expect(source).toContain(text);
  });
  it("uses existing M14/M15/publishing reads and owner-editor mutations", () => {
    for (const text of [
      "metrics/snapshots",
      "performance-intelligence/reports",
      "performance-intelligence/recommendations",
      "publishing/published-records",
      "analytics/collection-jobs",
      "Generate report",
      "Generate recommendations",
      "Approve",
    ])
      expect(source).toContain(text);
  });
  it("keeps unavailable and insufficient states honest", () => {
    for (const text of [
      "Missing values remain unavailable",
      "PARTIAL",
      "UNAVAILABLE",
      "INSUFFICIENT_DATA",
      "NOT_CONFIGURED",
      "Genre comparisons are not supported",
      "value === null",
    ])
      expect(source).toContain(text);
  });
});
