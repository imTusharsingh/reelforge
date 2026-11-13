import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { LatestMetricSnapshot } from "@reelforge/contracts";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsController } from "./analytics.controller.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const socialAccountId = "33333333-3333-4333-8333-333333333333";
const request = { principal: { userId: "44444444-4444-4444-8444-444444444444" } };
const snapshot: LatestMetricSnapshot = {
  id: "55555555-5555-4555-8555-555555555555",
  key: "views",
  value: 42,
  unit: "COUNT",
  entityGranularity: "CHANNEL",
  remoteEntityId: null,
  periodStart: "2026-11-01",
  periodEnd: "2026-11-01",
  collectedAt: "2026-11-02T00:00:00.000Z",
  sourceApi: "youtubeanalytics.googleapis.com/v2/reports",
  completeness: "PARTIAL",
  availability: "AVAILABLE",
  unavailableReason: null,
};

type MockMethod = ReturnType<typeof vi.fn>;

function setup(role: "VIEWER" | "EDITOR" = "VIEWER"): {
  controller: AnalyticsController;
  analytics: { listLatestSnapshots: MockMethod };
  workspaces: { context: MockMethod };
} {
  const analytics = { listLatestSnapshots: vi.fn().mockResolvedValue([snapshot]) };
  const workspaces = {
    context: vi.fn().mockResolvedValue({ workspaceId, userId: request.principal.userId, role }),
  };
  return {
    controller: new AnalyticsController(analytics as never, workspaces as never),
    analytics,
    workspaces,
  };
}

describe("AnalyticsController snapshots route", () => {
  it.each([
    ["CHANNEL", undefined],
    ["VIDEO", undefined],
    ["VIDEO", "video-1"],
  ] as const)(
    "allows a viewer to read %s snapshots with remote id %s",
    async (granularity, remoteEntityId) => {
      const { controller, analytics, workspaces } = setup("VIEWER");
      const query = {
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        granularity,
        ...(remoteEntityId === undefined ? {} : { remoteEntityId }),
      };
      const result = await controller.snapshots(request as never, workspaceId, channelId, query);
      expect(result[0]).toMatchObject({
        sourceApi: snapshot.sourceApi,
        completeness: "PARTIAL",
        availability: "AVAILABLE",
      });
      expect(workspaces.context).toHaveBeenCalledWith(request.principal.userId, workspaceId);
      expect(analytics.listLatestSnapshots).toHaveBeenCalledWith(
        expect.objectContaining({ role: "VIEWER" }),
        { channelId, ...query },
      );
    },
  );

  it("returns 400 for an invalid query", async () => {
    const { controller } = setup();
    await expect(
      controller.snapshots(request as never, workspaceId, channelId, {
        socialAccountId,
        startDate: "bad",
        endDate: "2026-11-02",
        granularity: "CHANNEL",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("preserves the service 404 for an unknown channel or account", async () => {
    const { controller, analytics } = setup();
    analytics.listLatestSnapshots.mockRejectedValue(new NotFoundException("Channel not found"));
    await expect(
      controller.snapshots(request as never, workspaceId, channelId, {
        socialAccountId,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        granularity: "CHANNEL",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
