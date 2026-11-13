import type {
  Channel,
  CreatePostRequest,
  EligibleRender,
  PlatformAvailability,
  Post,
  Preflight,
  PublishedRecord,
  SocialAccount,
} from "../model";

export const workspaceId = "20000000-0000-4000-8000-000000000001";
export const secondWorkspaceId = "20000000-0000-4000-8000-000000000002";
export const channelId = "20000000-0000-4000-8000-000000000003";
export const accountId = "20000000-0000-4000-8000-000000000004";
export const instagramAccountId = "20000000-0000-4000-8000-000000000005";
export const renderJobId = "20000000-0000-4000-8000-000000000006";
export const qualityReviewRunId = "20000000-0000-4000-8000-000000000007";
export const postId = "20000000-0000-4000-8000-000000000008";
export const destinationId = "20000000-0000-4000-8000-000000000009";
export const clientRequestId = "20000000-0000-4000-8000-000000000010";

export const platforms: PlatformAvailability[] = [
  { platform: "YOUTUBE", connectable: true, publishable: true, reasonCode: null },
  {
    platform: "INSTAGRAM",
    connectable: false,
    publishable: false,
    reasonCode: "INSTAGRAM_NOT_VERIFIED",
  },
];

export const channels: Channel[] = [
  { id: channelId, workspaceId, name: "Fixture channel", status: "ACTIVE" },
];

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
  },
];

export const eligibleRender: EligibleRender = {
  renderJobId,
  channelId,
  scriptId: "20000000-0000-4000-8000-000000000011",
  title: "Fixture approved render",
  durationMs: 42_000,
  completedAt: "2026-11-13T09:00:00.000Z",
  qualityReviewRunId,
  reviewStatus: "APPROVED",
  reviewedAt: "2026-11-13T09:05:00.000Z",
};

export const createRequest: CreatePostRequest = {
  clientRequestId,
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
        title: "Fixture approved render",
        description: "A fixture description",
        privacyStatus: "private",
        selfDeclaredMadeForKids: false,
      },
    },
  ],
};

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

export const passingPreflight: Preflight = {
  scheduledPostId: postId,
  destinationId,
  canPublish: true,
  gates: [
    { id: "APPROVAL", passed: true, evidence: ["current approval"] },
    { id: "HARD_GATES", passed: true, evidence: ["all gates pass"] },
  ],
};

export const blockedPreflight: Preflight = {
  ...passingPreflight,
  canPublish: false,
  gates: [
    { id: "APPROVAL", passed: true, evidence: ["current approval"] },
    {
      id: "SCHEDULE",
      passed: false,
      evidence: ["Publishing schedule policy is not configured"],
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
