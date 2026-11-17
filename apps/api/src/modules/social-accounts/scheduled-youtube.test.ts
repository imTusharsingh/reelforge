import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledYouTube } from "./scheduled-youtube.js";
const metadata = {
  platform: "YOUTUBE" as const,
  title: "A Short",
  description: "Original science",
  tags: ["science"],
  privacyStatus: "private" as const,
  selfDeclaredMadeForKids: false,
};
const publishAt = "2027-03-14T07:00:00Z";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-03-13T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());
describe("V9 YouTube adapter with fake fetch", () => {
  it("inserts private with publishAt and synthetic disclosure using the existing token", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/session/fake" },
        }),
    );
    const youtube = new ScheduledYouTube(request);
    expect(await youtube.start("fake-token", metadata, publishAt, 128, "video/mp4")).toContain(
      "/fake",
    );
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      snippet: { title: metadata.title },
      status: { privacyStatus: "private", publishAt, containsSyntheticMedia: true },
    });
  });
  it("fails closed on revoked tokens, unknown insert outcomes and unsafe sessions", async () => {
    const revoked = new ScheduledYouTube(vi.fn(async () => new Response(null, { status: 401 })));
    await expect(revoked.start("fake", metadata, publishAt, 1, "video/mp4")).rejects.toMatchObject({
      detail: { kind: "AUTH_REQUIRED" },
    });
    const missing = new ScheduledYouTube(vi.fn(async () => new Response(null)));
    await expect(missing.start("fake", metadata, publishAt, 1, "video/mp4")).rejects.toThrow(
      "UNKNOWN",
    );
    const unsafe = new ScheduledYouTube(
      vi.fn(
        async () => new Response(null, { headers: { location: "https://evil.invalid/session" } }),
      ),
    );
    await expect(unsafe.start("fake", metadata, publishAt, 1, "video/mp4")).rejects.toThrow();
    const timeout = new ScheduledYouTube(
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    await expect(timeout.start("fake", metadata, publishAt, 1, "video/mp4")).rejects.toThrow(
      "UNKNOWN",
    );
  });
  it("verifies channel, disclosure, schedule and later public state", async () => {
    const video = {
      id: "video",
      snippet: { channelId: "channel", title: metadata.title, description: metadata.description },
      status: {
        privacyStatus: "private",
        uploadStatus: "processed",
        containsSyntheticMedia: true,
        publishAt,
      },
      processingDetails: { processingStatus: "succeeded" },
    };
    const request = vi.fn<typeof fetch>(async () => Response.json({ items: [video] }));
    const youtube = new ScheduledYouTube(request);
    expect(
      (await youtube.verify("fake", "video", "channel", metadata, publishAt)).privacyStatus,
    ).toBe("private");
    await expect(youtube.verify("fake", "video", "other", metadata, publishAt)).rejects.toThrow(
      "MISMATCH",
    );
    video.status.containsSyntheticMedia = false;
    await expect(youtube.verify("fake", "video", "channel", metadata, publishAt)).rejects.toThrow(
      "MISMATCH",
    );
    video.status.containsSyntheticMedia = true;
    video.status.privacyStatus = "public";
    await expect(youtube.verify("fake", "video", "channel", metadata, publishAt)).rejects.toThrow(
      "MISMATCH",
    );
    vi.setSystemTime(new Date("2027-03-14T07:01:00Z"));
    expect(
      (await youtube.verify("fake", "video", "channel", metadata, publishAt)).privacyStatus,
    ).toBe("public");
  });
});
