import type { PublishedPostRecord, SocialPlatform } from "@reelforge/contracts";
import type { PublishAttemptStatus, PublishStatus } from "@reelforge/database";
import type { HardGateResult } from "../quality/quality.types.js";

export type PublishingPreflightGate = Readonly<{
  id:
    | "APPROVAL"
    | "HARD_GATES"
    | "MEDIA"
    | "METADATA"
    | "ACCOUNT"
    | "SCOPE"
    | "SCHEDULE"
    | "BUDGET"
    | "DISCLOSURE"
    | "RECONCILIATION_STORAGE";
  passed: boolean;
  evidence: readonly string[];
}>;

export type PublishingPreflightView = Readonly<{
  scheduledPostId: string;
  destinationId: string;
  canPublish: boolean;
  gates: readonly PublishingPreflightGate[];
  hardGates: readonly HardGateResult[] | null;
}>;

export type PublishingDestinationView = Readonly<{
  id: string;
  platform: SocialPlatform;
  socialAccountId: string;
  status: PublishStatus;
  remotePostId: string | null;
  publishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  metadata: unknown;
  idempotencyKey: string;
  latestAttempt: Readonly<{
    id: string;
    attemptNumber: number;
    status: PublishAttemptStatus;
    confirmedBytes: string;
    totalBytes: string | null;
    remotePostId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  }> | null;
}>;

export type ScheduledPostView = Readonly<{
  id: string;
  channelId: string;
  renderJobId: string;
  qualityReviewRunId: string;
  revision: number;
  scheduledAt: string | null;
  status: PublishStatus;
  disclosureDecision: "DISCLOSE" | "NOT_REQUIRED";
  disclosureText: string | null;
  disclosureReason: string;
  manuallyAuthorizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  destinations: readonly PublishingDestinationView[];
}>;

export type PublishedPostExport = PublishedPostRecord;

export type PublishingPlatformView = Readonly<{
  platform: SocialPlatform;
  connectable: boolean;
  publishable: boolean;
  reasonCode: "PLATFORM_NOT_CONFIGURED" | "PUBLISHING_NOT_CONFIGURED" | "INSTAGRAM_NOT_VERIFIED" | null;
}>;

export type EligibleRenderView = Readonly<{
  renderJobId: string;
  channelId: string;
  projectId: string;
  title: string;
  durationMs: number;
  completedAt: string;
  qualityReviewRunId: string;
  reviewStatus: "APPROVED" | "AUTO_APPROVED";
  reviewedAt: string;
}>;

export type EligibleRenderPage = Readonly<{
  items: readonly EligibleRenderView[];
  nextCursor: string | null;
}>;

