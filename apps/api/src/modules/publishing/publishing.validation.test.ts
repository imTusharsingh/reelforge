import { describe, expect, it } from "vitest";
import {
  CalendarRangeSchema,
  CreateScheduledPostSchema,
  UpdateScheduledPostSchema,
} from "./publishing.validation.js";

const channelId = "11111111-1111-4111-8111-111111111111";
const renderJobId = "22222222-2222-4222-8222-222222222222";
const reviewId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";

describe("publishing request schemas", () => {
  it("requires explicit disclosure and strict destination metadata", () => {
    const base = {
      channelId,
      renderJobId,
      qualityReviewRunId: reviewId,
      scheduledAt: null,
      destinations: [
        {
          platform: "YOUTUBE",
          socialAccountId: accountId,
          metadata: {
            platform: "YOUTUBE",
            title: "Test video",
            description: "",
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
          },
        },
      ],
    };
    expect(CreateScheduledPostSchema.safeParse(base).success).toBe(false);
    expect(
      CreateScheduledPostSchema.safeParse({
        ...base,
        disclosure: { decision: "NOT_REQUIRED", reason: "No paid promotion" },
      }).success,
    ).toBe(true);
    expect(
      CreateScheduledPostSchema.safeParse({
        ...base,
        disclosure: { decision: "NOT_REQUIRED", reason: "No paid promotion" },
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate connected accounts and invalid calendar ranges", () => {
    const destination = {
      platform: "YOUTUBE",
      socialAccountId: accountId,
      metadata: {
        platform: "YOUTUBE",
        title: "Test video",
        description: "",
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
      },
    };
    expect(
      CreateScheduledPostSchema.safeParse({
        channelId,
        renderJobId,
        qualityReviewRunId: reviewId,
        scheduledAt: null,
        disclosure: { decision: "NOT_REQUIRED", reason: "No paid promotion" },
        destinations: [destination, destination],
      }).success,
    ).toBe(false);
    expect(
      CalendarRangeSchema.safeParse({
        from: "2026-03-02T00:00:00.000Z",
        to: "2026-03-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(UpdateScheduledPostSchema.safeParse({}).success).toBe(false);
  });
});
