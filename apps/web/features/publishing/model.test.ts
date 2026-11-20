import { describe, expect, it } from "vitest";
import { formatDuration, parseAuthorizationUrl, parseHistory } from "./model";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const channelId = "10000000-0000-4000-8000-000000000002";
const renderJobId = "10000000-0000-4000-8000-000000000003";
const postId = "10000000-0000-4000-8000-000000000006";
const destinationId = "10000000-0000-4000-8000-000000000007";

describe("M27 publishing model validation", () => {
  it("rejects foreign history records and insecure authorization URLs", () => {
    expect(() =>
      parseHistory(
        [
          {
            workspaceId: "other",
            channelId,
            scheduledPostId: postId,
            destinationId,
            renderJobId,
            platform: "YOUTUBE",
            platformPostId: "remote-1",
            publishedAt: "2026-11-13T10:00:00.000Z",
          },
        ],
        workspaceId,
      ),
    ).toThrow();
    expect(parseAuthorizationUrl({ authorizationUrl: "https://accounts.example.test/auth" })).toBe(
      "https://accounts.example.test/auth",
    );
    expect(() =>
      parseAuthorizationUrl({ authorizationUrl: "http://accounts.example.test/auth" }),
    ).toThrow();
    expect(formatDuration(65_000)).toBe("1:05");
  });
});
