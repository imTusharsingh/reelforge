import { describe, expect, it } from "vitest";
import {
  describeGates,
  formatDuration,
  parseAuthorizationUrl,
  parseCreatePostRequest,
  parseEligibleRenders,
  parseHistory,
  parsePost,
  parsePostPage,
  parsePreflight,
  type CreatePostRequest,
} from "./model";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const channelId = "10000000-0000-4000-8000-000000000002";
const renderJobId = "10000000-0000-4000-8000-000000000003";
const qualityReviewRunId = "10000000-0000-4000-8000-000000000004";
const accountId = "10000000-0000-4000-8000-000000000005";
const postId = "10000000-0000-4000-8000-000000000006";
const destinationId = "10000000-0000-4000-8000-000000000007";

const request: CreatePostRequest = {
  clientRequestId: "10000000-0000-4000-8000-000000000008",
  channelId,
  renderJobId,
  qualityReviewRunId,
  scheduledAt: null,
  disclosure: { decision: "NOT_REQUIRED", reason: "No promotional content" },
  destinations: [
    {
      platform: "YOUTUBE",
      socialAccountId: accountId,
      metadata: {
        platform: "YOUTUBE",
        title: "A verified render",
        description: "Description",
        tags: ["forge"],
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
      },
    },
  ],
};

const destination = {
  id: destinationId,
  platform: "YOUTUBE" as const,
  socialAccountId: accountId,
  status: "SCHEDULED",
  remotePostId: null,
  publishedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  latestAttempt: null,
};

const post = {
  id: postId,
  channelId,
  renderJobId,
  qualityReviewRunId,
  revision: 1,
  scheduledAt: "2026-11-20T10:00:00.000Z",
  status: "SCHEDULED",
  disclosureDecision: "NOT_REQUIRED" as const,
  disclosureText: null,
  disclosureReason: "No promotional content",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  destinations: [destination],
};

describe("M27 publishing model validation", () => {
  it("round-trips a strict composer request", () => {
    expect(parseCreatePostRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(parseCreatePostRequest(request, request.clientRequestId)).toEqual(request);
    expect(() => parseCreatePostRequest(request, "different")).toThrow();
  });

  it("rejects invalid metadata at the trust boundary", () => {
    const badPrivacy = structuredClone(request) as unknown as Record<string, unknown>;
    const destinations = badPrivacy["destinations"] as Record<string, unknown>[];
    (destinations[0]!["metadata"] as Record<string, unknown>)["privacyStatus"] = "everyone";
    expect(() => parseCreatePostRequest(badPrivacy)).toThrow();

    const longTitle = structuredClone(request);
    longTitle.destinations[0]!.metadata = {
      platform: "YOUTUBE",
      title: "x".repeat(101),
      description: "",
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
    };
    expect(() => parseCreatePostRequest(longTitle)).toThrow();

    const missingReason = structuredClone(request) as unknown as Record<string, unknown>;
    missingReason["disclosure"] = { decision: "NOT_REQUIRED", reason: "" };
    expect(() => parseCreatePostRequest(missingReason)).toThrow();
  });

  it("parses posts, pages and eligible renders without trusting foreign data", () => {
    expect(parsePost(JSON.parse(JSON.stringify(post)), postId)).toEqual(post);
    expect(() => parsePost({ ...post, id: "other" }, postId)).toThrow();
    expect(parsePostPage({ items: [post], nextCursor: null })).toEqual({
      items: [post],
      nextCursor: null,
    });
    expect(() => parsePostPage({ items: [{ ...post, scheduledAt: "nope" }] })).toThrow();
    expect(
      parseEligibleRenders({
        items: [
          {
            renderJobId,
            channelId,
            projectId: "10000000-0000-4000-8000-000000000009",
            title: "Approved",
            durationMs: 42_000,
            completedAt: "2026-11-13T10:00:00.000Z",
            qualityReviewRunId,
            reviewStatus: "APPROVED",
            reviewedAt: "2026-11-13T10:00:00.000Z",
          },
        ],
        nextCursor: "cursor",
      }),
    ).toMatchObject({ nextCursor: "cursor" });
    expect(() =>
      parseEligibleRenders({ items: [{ renderJobId, reviewStatus: "REVIEW_REQUIRED" }] }),
    ).toThrow();
  });

  it("validates preflight gates and evidence", () => {
    const preflight = {
      scheduledPostId: postId,
      destinationId,
      canPublish: false,
      gates: [
        { id: "APPROVAL", passed: true, evidence: ["current"] },
        { id: "SCHEDULE", passed: false, evidence: ["policy not configured"] },
      ],
    };
    expect(parsePreflight(preflight, destinationId)).toMatchObject({ canPublish: false });
    expect(() => parsePreflight(preflight, "different")).toThrow();
    expect(() =>
      parsePreflight({ ...preflight, gates: [{ id: "APPROVAL", passed: true }] }, destinationId),
    ).toThrow();
    expect(describeGates(parsePreflight(preflight, destinationId).gates)).toEqual([
      "APPROVAL: passed — current",
      "SCHEDULE: failed — policy not configured",
    ]);
  });

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
    expect(() => parseAuthorizationUrl({ authorizationUrl: "http://accounts.example.test/auth" })).toThrow();
    expect(formatDuration(65_000)).toBe("1:05");
  });
});
