import type { Post, PublishedRecord, SocialAccount } from "./model";

export const workspaceId = "20000000-0000-4000-8000-000000000001";
export const secondWorkspaceId = "20000000-0000-4000-8000-000000000002";
const channelId = "20000000-0000-4000-8000-000000000003";
export const accountId = "20000000-0000-4000-8000-000000000004";
const renderJobId = "20000000-0000-4000-8000-000000000006";
const qualityReviewRunId = "20000000-0000-4000-8000-000000000007";
const postId = "20000000-0000-4000-8000-000000000008";
const destinationId = "20000000-0000-4000-8000-000000000009";

export const accounts: SocialAccount[] = [
  {
    id: accountId,
    workspaceId,
    channelId,
    platform: "YOUTUBE",
    remoteAccountId: "fixture-remote-account",
    displayName: "Fixture YouTube",
    username: "fixture",
    status: "CONNECTED",
    health: "HEALTHY",
    connectedAt: "2026-11-13T10:00:00.000Z",
  },
];

export const post: Post = {
  id: postId,
  channelId,
  renderJobId,
  qualityReviewRunId,
  revision: 1,
  scheduledAt: null,
  status: "DRAFT",
  disclosureDecision: "NOT_REQUIRED",
  disclosureText: null,
  disclosureReason: "No promotional content",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  destinations: [
    {
      id: destinationId,
      platform: "YOUTUBE",
      socialAccountId: accountId,
      status: "DRAFT",
      remotePostId: null,
      publishedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      latestAttempt: null,
    },
  ],
};

export const publishedRecord: PublishedRecord = {
  workspaceId,
  channelId,
  scheduledPostId: postId,
  destinationId,
  renderJobId,
  platform: "YOUTUBE",
  platformPostId: "fixture-platform-post",
  publishedAt: "2026-11-13T11:00:00.000Z",
};
