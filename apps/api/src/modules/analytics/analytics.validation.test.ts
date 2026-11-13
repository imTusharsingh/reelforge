import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { parseLatestMetricSnapshotQuery } from "./analytics.validation.js";

const ids = {
  channelId: "11111111-1111-4111-8111-111111111111",
  socialAccountId: "22222222-2222-4222-8222-222222222222",
};

describe("latest metric snapshot query", () => {
  it("accepts channel and video queries", () => {
    expect(
      parseLatestMetricSnapshotQuery({
        ...ids,
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        granularity: "CHANNEL",
      }).granularity,
    ).toBe("CHANNEL");
    expect(
      parseLatestMetricSnapshotQuery({
        ...ids,
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        granularity: "VIDEO",
        remoteEntityId: "video-1",
      }).remoteEntityId,
    ).toBe("video-1");
  });
  it("rejects malformed windows and channel video filters", () => {
    expect(() =>
      parseLatestMetricSnapshotQuery({
        ...ids,
        startDate: "bad",
        endDate: "2026-01-02",
        granularity: "CHANNEL",
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseLatestMetricSnapshotQuery({
        ...ids,
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        granularity: "CHANNEL",
        remoteEntityId: "video-1",
      }),
    ).toThrow(BadRequestException);
  });
});
