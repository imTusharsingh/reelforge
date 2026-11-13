import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./insights-screen.tsx", import.meta.url), "utf8");

describe("M28 insights screen contracts", () => {
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
