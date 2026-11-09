import { describe, expect, it } from "vitest";
import {
  DisclosureDecisionSchema,
  PublishedPostRecordSchema,
  YouTubeDestinationMetadataSchema,
} from "./publishing.js";

describe("publishing contracts", () => {
  it("requires explicit destination privacy and valid metadata", () => {
    expect(
      YouTubeDestinationMetadataSchema.parse({
        platform: "YOUTUBE",
        title: "Fixture title",
        description: "",
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
      }),
    ).toMatchObject({ privacyStatus: "private" });
    expect(
      YouTubeDestinationMetadataSchema.safeParse({
        platform: "YOUTUBE",
        title: "Fixture title",
        description: "",
        selfDeclaredMadeForKids: false,
      }).success,
    ).toBe(false);
  });

  it("requires an explicit, reasoned disclosure decision", () => {
    expect(
      DisclosureDecisionSchema.safeParse({ decision: "NOT_REQUIRED", reason: "Fixture decision" })
        .success,
    ).toBe(true);
    expect(DisclosureDecisionSchema.safeParse({ decision: "NOT_REQUIRED" }).success).toBe(false);
  });

  it("validates the stable M14 published-post record", () => {
    expect(
      PublishedPostRecordSchema.parse({
        workspaceId: "00000000-0000-4000-8000-000000000001",
        channelId: "00000000-0000-4000-8000-000000000002",
        scheduledPostId: "00000000-0000-4000-8000-000000000003",
        destinationId: "00000000-0000-4000-8000-000000000004",
        publishJobId: "00000000-0000-4000-8000-000000000005",
        renderJobId: "00000000-0000-4000-8000-000000000006",
        accountId: "00000000-0000-4000-8000-000000000007",
        platform: "YOUTUBE",
        platformPostId: "fixture-video",
        publishedAt: "2026-11-10T00:00:00.000Z",
      }),
    ).toMatchObject({ platformPostId: "fixture-video" });
  });
});
