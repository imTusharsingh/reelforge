import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@reelforge/database";
import { Prisma } from "@reelforge/database";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionService } from "../composition/composition.service.js";
import type { QualityService } from "../quality/quality.service.js";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { RenderManifest } from "../composition/composition.manifest.js";
import type { ScheduledPostView } from "./publishing.types.js";
import {
  type BudgetReservation,
  type PublishingBudgetPort,
  type PublishingPolicyContext,
  type PublishingSchedulePort,
  UnconfiguredPublishingBudgetPort,
  UnconfiguredPublishingSchedulePort,
} from "./publishing.ports.js";
import { PublishingService } from "./publishing.service.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const scheduledPostId = "33333333-3333-4333-8333-333333333333";
const destinationId = "44444444-4444-4444-8444-444444444444";
const renderJobId = "55555555-5555-4555-8555-555555555555";
const reviewId = "66666666-6666-4666-8666-666666666666";
const accountId = "77777777-7777-4777-8777-777777777777";
const jobId = "88888888-8888-4888-8888-888888888888";
const attemptId = "99999999-9999-4999-8999-999999999999";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const video = Buffer.from("fixture-video");
const videoChecksum = createHash("sha256").update(video).digest("hex");
type TestMock = ReturnType<typeof vi.fn>;
type UpdateMock = ReturnType<
  typeof vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>
>;
type PreflightFixtures = {
  destination: {
    status: string;
    publishJob: { id: string; attempts: Record<string, unknown>[] };
    scheduledPost: { channelId: string; disclosureReason: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  manifest: RenderManifest;
  render: Record<string, unknown>;
  account: {
    startVideoUpload: TestMock;
    checkVideoUpload: TestMock;
    uploadVideoChunk: TestMock;
    verifyUploadedVideo: TestMock;
  };
  quality: { get: TestMock; assertPublishable: TestMock };
  composition: { getManifest: TestMock };
  socialAccounts: { authenticatedClient: TestMock };
  db: {
    publishingDestination: { findUnique: TestMock };
    renderJob: { findUnique: TestMock };
  };
};
type PublishHarness = {
  publishing: PublishingService;
  fixtures: PreflightFixtures;
  db: object;
  tx: {
    publishAttempt: { update: UpdateMock; create: TestMock };
    publishingDestination: { update: TestMock };
  };
  publishAttemptUpdate: UpdateMock;
};

function context(role: WorkspaceContext["role"] = "OWNER", id = workspaceId): WorkspaceContext {
  return { workspaceId: id, userId, role };
}

class AllowingSchedule implements PublishingSchedulePort {
  public async check(
    context: PublishingPolicyContext,
  ): Promise<{ allowed: boolean; reason: string }> {
    void context;
    return { allowed: true, reason: "Fixture schedule allows publish." };
  }
}

class AllowingBudget implements PublishingBudgetPort {
  public async check(
    context: PublishingPolicyContext,
  ): Promise<{ allowed: boolean; reason: string }> {
    void context;
    return { allowed: true, reason: "Fixture budget allows publish." };
  }

  public async reserve(context: PublishingPolicyContext): Promise<BudgetReservation> {
    void context;
    return { reservationId: "fixture-reservation" };
  }

  public async settle(reservation: BudgetReservation): Promise<void> {
    void reservation;
  }

  public async release(reservation: BudgetReservation): Promise<void> {
    void reservation;
  }
}

type ServiceOverrides = {
  composition?: object;
  quality?: object;
  socialAccounts?: object;
  storage?: Partial<StoragePort>;
  schedule?: PublishingSchedulePort;
  budget?: PublishingBudgetPort;
};

function service(db: object, overrides: ServiceOverrides = {}): PublishingService {
  return new PublishingService(
    db as PrismaClient,
    (overrides.composition ?? {}) as CompositionService,
    (overrides.quality ?? {}) as QualityService,
    (overrides.socialAccounts ?? {}) as SocialAccountsService,
    (overrides.storage ?? {}) as StoragePort,
    overrides.schedule ?? new UnconfiguredPublishingSchedulePort(),
    overrides.budget ?? new UnconfiguredPublishingBudgetPort(),
    new PublishingSessionVault(encryptionKey),
  );
}

function preflightFixtures(
  options: {
    platform?: "YOUTUBE" | "INSTAGRAM";
    decision?: "DISCLOSE" | "NOT_REQUIRED";
    disclosureText?: string | null;
    description?: string;
    reviewStatus?: string;
    assertError?: Error;
  } = {},
): PreflightFixtures {
  const platform = options.platform ?? "YOUTUBE";
  const metadata =
    platform === "YOUTUBE"
      ? {
          platform,
          title: "Fixture title",
          description: options.description ?? "Fixture description",
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
        }
      : { platform, caption: "Fixture caption" };
  const destination = {
    id: destinationId,
    workspaceId,
    scheduledPostId,
    socialAccountId: accountId,
    platform,
    metadata,
    status: "DRAFT",
    remotePostId: null,
    publishedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    idempotencyKey: "fixture-idempotency-key",
    publishJob: { id: jobId, attempts: [] as Record<string, unknown>[] },
    scheduledPost: {
      id: scheduledPostId,
      workspaceId,
      channelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      renderJobId,
      qualityReviewRunId: reviewId,
      scheduledAt: null,
      disclosureDecision: options.decision ?? "NOT_REQUIRED",
      disclosureText:
        options.disclosureText ?? (options.decision === "DISCLOSE" ? "Paid promotion" : null),
      disclosureReason: "Fixture disclosure decision",
    },
  };
  const asset = {
    kind: "VIDEO",
    objectKey: "renders/fixture.mp4",
    byteSize: video.byteLength,
    checksumSha256: videoChecksum,
  };
  const manifest = {
    video: {
      objectKey: asset.objectKey,
      byteSize: asset.byteSize,
      checksumSha256: asset.checksumSha256,
      mediaType: "video/mp4",
    },
  } as RenderManifest;
  const render = {
    status: "SUCCEEDED",
    expiredAt: null,
    sceneMediaJob: { channelId: destination.scheduledPost.channelId },
    artifacts: [asset],
  };
  const account = {
    account: {
      channelId: destination.scheduledPost.channelId,
      platform,
      health: "HEALTHY",
      permissions: [
        {
          permission: "https://www.googleapis.com/auth/youtube.upload",
          status: "GRANTED",
        },
      ],
      capabilities: ["VIDEO_UPLOAD", "RESUMABLE_UPLOAD"].map((capability) => ({
        capability,
        enabled: true,
        details: { executionImplemented: true },
      })),
    },
    startVideoUpload: vi.fn().mockResolvedValue("https://www.googleapis.com/upload/session"),
    checkVideoUpload: vi.fn().mockResolvedValue({
      completed: true,
      nextByte: 0,
      videoId: "fixture-remote-video",
    }),
    uploadVideoChunk: vi.fn(),
    verifyUploadedVideo: vi.fn().mockResolvedValue({
      videoId: "fixture-remote-video",
      channelId: "fixture-remote-channel",
      title: "Fixture title",
      privacyStatus: "private",
      uploadStatus: "processed",
      processingStatus: "succeeded",
    }),
  };
  const quality = {
    get: vi.fn().mockResolvedValue({
      status: options.reviewStatus ?? "APPROVED",
      gateSummary: [{ id: "rights", passed: true, evidence: ["fixture"] }],
    }),
    assertPublishable:
      options.assertError ||
      (options.reviewStatus !== undefined &&
      options.reviewStatus !== "APPROVED" &&
      options.reviewStatus !== "AUTO_APPROVED"
        ? new ConflictException("The current quality review is not approved for publishing")
        : null)
        ? vi
            .fn()
            .mockRejectedValue(
              options.assertError ??
                new ConflictException("The current quality review is not approved for publishing"),
            )
        : vi.fn().mockResolvedValue([{ id: "rights", passed: true, evidence: ["current"] }]),
  };
  const composition = { getManifest: vi.fn().mockResolvedValue(manifest) };
  const socialAccounts = { authenticatedClient: vi.fn().mockResolvedValue(account) };
  const db = {
    publishingDestination: { findUnique: vi.fn().mockResolvedValue(destination) },
    renderJob: { findUnique: vi.fn().mockResolvedValue(render) },
  };
  return {
    destination,
    manifest,
    render,
    account,
    quality,
    composition,
    socialAccounts,
    db,
  };
}

function allowedDependencies(fixtures: ReturnType<typeof preflightFixtures>): ServiceOverrides {
  return {
    composition: fixtures.composition,
    quality: fixtures.quality,
    socialAccounts: fixtures.socialAccounts,
    storage: { getObject: vi.fn().mockResolvedValue(video) },
    schedule: new AllowingSchedule(),
    budget: new AllowingBudget(),
  };
}

function publishHarness(
  failedSessionWrites: number,
  priorAttempt: Record<string, unknown> | null = null,
): PublishHarness {
  const fixtures = preflightFixtures();
  if (priorAttempt !== null) {
    fixtures.destination.status = "FAILED_RETRYABLE";
    fixtures.destination.publishJob.attempts = [priorAttempt];
  }
  const tx = {
    publishJob: {
      findUnique: vi.fn().mockResolvedValue({ status: "DRAFT", retryCount: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    publishAttempt: {
      count: vi.fn().mockResolvedValue(priorAttempt === null ? 0 : 1),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: String(args.data["id"]),
      })),
      update: vi.fn().mockResolvedValue({}),
    },
    publishingDestination: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ status: "UPLOADING", publishedAt: null }),
      findMany: vi.fn().mockResolvedValue([{ status: "PUBLISHED" }]),
    },
    scheduledPost: { update: vi.fn().mockResolvedValue({}) },
    outboxEvent: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn(
    async (callback: (client: typeof tx) => Promise<unknown>): Promise<unknown> => callback(tx),
  );
  const publishAttemptUpdate = vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      if ("sessionCiphertext" in args.data && failedSessionWrites > 0) {
        failedSessionWrites--;
        throw new Error("fixture session persistence failure");
      }
      return {};
    },
  );
  const publishedPost = {
    id: scheduledPostId,
    channelId: fixtures.destination.scheduledPost.channelId,
    renderJobId,
    qualityReviewRunId: reviewId,
    revision: 1,
    scheduledAt: null,
    status: "PUBLISHED",
    disclosureDecision: "NOT_REQUIRED",
    disclosureText: null,
    disclosureReason: "Fixture disclosure decision",
    manuallyAuthorizedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    destinations: [],
  };
  const db = {
    publishingDestination: fixtures.db.publishingDestination,
    renderJob: fixtures.db.renderJob,
    publishAttempt: { update: publishAttemptUpdate },
    scheduledPost: { findUnique: vi.fn().mockResolvedValue(publishedPost) },
    $transaction: transaction,
  };
  const publishing = service(db, {
    ...allowedDependencies(fixtures),
    budget: new AllowingBudget(),
  });
  vi.spyOn(publishing, "preflight").mockResolvedValue({
    scheduledPostId,
    destinationId,
    canPublish: true,
    gates: [],
    hardGates: [],
  });
  return { publishing, fixtures, db, tx, publishAttemptUpdate };
}

describe("PublishingService authorization", () => {
  it("does not allow a viewer to create or mutate scheduled posts", async () => {
    const findUnique = vi.fn();
    const publishing = service({ scheduledPost: { findUnique } });
    await expect(publishing.createScheduledPost(context("VIEWER"), {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      publishing.cancelScheduledPost(context("VIEWER"), scheduledPostId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("scopes scheduled-post lookup to the active workspace", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const publishing = service({ scheduledPost: { findUnique } });
    await expect(
      publishing.getScheduledPost(context("VIEWER"), scheduledPostId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId, id: scheduledPostId } },
      }),
    );
  });

  it("blocks retry while the prior upload outcome remains unknown", async () => {
    const destinationId = "44444444-4444-4444-8444-444444444444";
    const jobId = "55555555-5555-4555-8555-555555555555";
    const findUnique = vi.fn().mockResolvedValue({
      id: destinationId,
      workspaceId,
      status: "RECONCILIATION_REQUIRED",
      remotePostId: null,
      scheduledPostId,
      scheduledPost: { id: scheduledPostId },
      publishJob: {
        id: jobId,
        attempts: [{ sessionCiphertext: "encrypted", id: "attempt-id" }],
      },
    });
    const publishing = service({ publishingDestination: { findUnique } });
    const reconcile = vi
      .spyOn(publishing, "reconcile")
      .mockResolvedValue({} as unknown as ScheduledPostView);
    const preflight = vi.spyOn(publishing, "preflight");

    await expect(publishing.retry(context(), destinationId)).rejects.toThrow(
      /outcome is still unknown/i,
    );
    expect(reconcile).toHaveBeenCalledOnce();
    expect(preflight).not.toHaveBeenCalled();
  });

  it("denies viewers and cross-workspace members on publish, retry, and reconcile", async () => {
    const workspaceFind = vi.fn().mockResolvedValue(null);
    const publishing = service({
      publishingDestination: { findUnique: workspaceFind },
    });
    for (const action of ["publishNow", "retry", "reconcile"] as const) {
      await expect(publishing[action](context("VIEWER"), destinationId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        publishing[action](context("OWNER", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), destinationId),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(workspaceFind).toHaveBeenCalledTimes(3);
    expect(workspaceFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            id: destinationId,
          },
        },
      }),
    );
  });
});

describe("unconfigured publishing dependencies", () => {
  it("denies scheduling and budget checks rather than fabricating approval", async () => {
    const schedule = await new UnconfiguredPublishingSchedulePort().check();
    const budget = new UnconfiguredPublishingBudgetPort();
    const budgetCheck = await budget.check();
    expect(schedule.allowed).toBe(false);
    expect(budgetCheck.allowed).toBe(false);
    await expect(budget.reserve()).rejects.toThrow(/not configured/i);
  });
});

describe("PublishingService preflight", () => {
  it("rechecks approved and rejected reviews through M11 at publish time", async () => {
    const stale = preflightFixtures({
      assertError: new ConflictException("The quality approval is stale; use the current review"),
    });
    const staleService = service(stale.db, allowedDependencies(stale));
    const staleResult = await staleService.preflight(context(), destinationId);
    expect(stale.quality.assertPublishable).toHaveBeenCalledWith(context(), renderJobId, reviewId);
    expect(staleResult.canPublish).toBe(false);
    expect(staleResult.gates.find((item) => item.id === "APPROVAL")?.passed).toBe(false);

    const rejected = preflightFixtures({ reviewStatus: "REJECTED" });
    const rejectedService = service(rejected.db, allowedDependencies(rejected));
    const rejectedResult = await rejectedService.preflight(context(), destinationId);
    expect(rejected.quality.assertPublishable).toHaveBeenCalledOnce();
    expect(rejectedResult.canPublish).toBe(false);
  });

  it("blocks DISCLOSE without the required destination description text", async () => {
    const fixtures = preflightFixtures({
      decision: "DISCLOSE",
      disclosureText: "Paid partnership",
      description: "An ordinary video description",
    });
    const publishing = service(fixtures.db, allowedDependencies(fixtures));
    const result = await publishing.preflight(context(), destinationId);
    expect(result.gates.find((item) => item.id === "DISCLOSURE")?.passed).toBe(false);
    expect(result.canPublish).toBe(false);
  });

  it("requires a non-empty reason when disclosure is declared unnecessary", async () => {
    const fixtures = preflightFixtures({ decision: "NOT_REQUIRED" });
    fixtures.destination.scheduledPost.disclosureReason = "  ";
    const publishing = service(fixtures.db, allowedDependencies(fixtures));
    const result = await publishing.preflight(context(), destinationId);
    expect(result.gates.find((item) => item.id === "DISCLOSURE")?.passed).toBe(false);
  });

  it("keeps Instagram preflight and publishing fail-closed", async () => {
    const fixtures = preflightFixtures({ platform: "INSTAGRAM" });
    const publishing = service(fixtures.db, allowedDependencies(fixtures));
    const result = await publishing.preflight(context(), destinationId);
    expect(result.canPublish).toBe(false);
    expect(result.gates.find((item) => item.id === "SCOPE")?.passed).toBe(false);
    await expect(publishing.publishNow(context(), destinationId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(fixtures.account.startVideoUpload).not.toHaveBeenCalled();
  });
});

describe("PublishingService published-post export", () => {
  it("queries only published rows with remote IDs in the active workspace", async () => {
    const row = {
      workspaceId,
      id: destinationId,
      scheduledPostId,
      socialAccountId: accountId,
      platform: "YOUTUBE",
      remotePostId: "fixture-remote-video",
      publishedAt: new Date("2026-11-10T00:00:00.000Z"),
      scheduledPost: { channelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", renderJobId },
      publishJob: { id: jobId },
    };
    const findMany = vi.fn().mockResolvedValue([row]);
    const publishing = service({
      publishingDestination: { findMany },
    });
    const records = await publishing.listPublishedRecords(context("VIEWER"));
    expect(records).toHaveLength(1);
    expect(records[0]?.platformPostId).toBe("fixture-remote-video");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId,
          status: "PUBLISHED",
          remotePostId: { not: null },
          publishedAt: { not: null },
        },
      }),
    );
    await publishing.listPublishedRecords(context(), "2026-11-10T00:00:00.000Z", 50, destinationId);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { publishedAt: { gt: new Date("2026-11-10T00:00:00.000Z") } },
            { publishedAt: new Date("2026-11-10T00:00:00.000Z"), id: { gt: destinationId } },
          ],
        }),
        orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("resolves read-only post context without exposing another workspace", async () => {
    const seriesId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const findMany = vi.fn().mockResolvedValue([
      {
        id: scheduledPostId,
        channelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        renderJobId,
        renderJob: {
          input: {
            scenes: [{ durationMs: 5_000 }, { durationMs: 5_000 }],
            profile: { transitionDurationMs: 1_000 },
          },
          sceneMediaJob: {
            script: {
              seriesId,
              snapshot: {
                topic: "AI tools",
                hook: "Question",
                seriesId,
                series: { id: seriesId, name: "Series A" },
              },
            },
          },
        },
      },
    ]);
    const assignmentFindMany = vi.fn().mockResolvedValue([
      {
        seriesId,
        group: { name: "Hosts", members: [{ character: { name: "Nova" } }] },
      },
    ]);
    const publishing = service({
      scheduledPost: { findMany },
      characterGroupAssignment: { findMany: assignmentFindMany },
    });

    const contexts = await publishing.listPublishedPostContexts(context("VIEWER"), [
      scheduledPostId,
    ]);
    expect(contexts).toEqual([
      {
        scheduledPostId,
        channelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        renderJobId,
        topic: "AI tools",
        hook: "Question",
        seriesId,
        seriesName: "Series A",
        characterNames: ["Nova"],
        durationSeconds: 9,
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, id: { in: [scheduledPostId] } },
      }),
    );
    expect(assignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, seriesId: { in: [seriesId] } },
      }),
    );

    await expect(publishing.listPublishedPostContexts(context(), [])).resolves.toEqual([]);
  });
});

describe("PublishingService YouTube delivery", () => {
  it("retries session persistence before transfer and stores the URI before continuing", async () => {
    const harness = publishHarness(1);
    await harness.publishing.publishNow(context(), destinationId);
    const sessionWrites = harness.publishAttemptUpdate.mock.calls.filter(
      (call) => "sessionCiphertext" in call[0].data,
    );
    expect(sessionWrites).toHaveLength(2);
    expect(sessionWrites[1]?.[0].data.sessionCiphertext).toEqual(expect.any(String));
    expect(harness.fixtures.account.checkVideoUpload).toHaveBeenCalledOnce();
    expect(harness.fixtures.account.startVideoUpload).toHaveBeenCalledOnce();
    expect(harness.tx.publishingDestination.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PUBLISHED" }) }),
    );
    expect(
      harness.tx.publishAttempt.update.mock.calls.some(
        (call) =>
          "remotePostId" in call[0].data && call[0].data.remotePostId === "fixture-remote-video",
      ),
    ).toBe(true);
  });

  it("marks the attempt final rather than reconciliation-required if session storage fails", async () => {
    const harness = publishHarness(3);
    await expect(harness.publishing.publishNow(context(), destinationId)).rejects.toThrow(
      /Could not persist resumable upload session/,
    );
    expect(harness.publishAttemptUpdate).toHaveBeenCalledTimes(3);
    expect(harness.tx.publishAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED_FINAL" }) }),
    );
    expect(harness.tx.publishAttempt.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RECONCILIATION_REQUIRED" }),
      }),
    );
  });

  it("resumes a known retryable session copied into the newly claimed attempt", async () => {
    const vault = new PublishingSessionVault(encryptionKey);
    const oldSession = "https://www.googleapis.com/upload/fixture-session";
    const encrypted = vault.encrypt(
      oldSession,
      `${workspaceId}:${jobId}:${attemptId}:youtube-upload-session`,
    );
    const priorAttempt = {
      id: attemptId,
      attemptNumber: 1,
      status: "FAILED_RETRYABLE",
      confirmedBytes: 0n,
      totalBytes: BigInt(video.byteLength),
      remotePostId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      sessionCiphertext: encrypted.ciphertext,
      sessionNonce: encrypted.nonce,
      sessionTag: encrypted.tag,
      sessionKeyVersion: encrypted.keyVersion,
    };
    const harness = publishHarness(0, priorAttempt);
    vi.spyOn(harness.publishing, "reconcile").mockResolvedValue({} as unknown as ScheduledPostView);

    await harness.publishing.retry(context(), destinationId);
    const createdData = harness.tx.publishAttempt.create.mock.calls[0]?.[0].data;
    expect(createdData?.sessionCiphertext).toEqual(expect.any(String));
    expect(
      vault.decrypt(
        {
          ciphertext: String(createdData?.sessionCiphertext),
          nonce: String(createdData?.sessionNonce),
          tag: String(createdData?.sessionTag),
          keyVersion: "env-v1",
        },
        `${workspaceId}:${jobId}:${String(createdData?.id)}:youtube-upload-session`,
      ),
    ).toBe(oldSession);
    expect(harness.fixtures.account.checkVideoUpload).toHaveBeenCalledOnce();
    expect(harness.fixtures.account.startVideoUpload).not.toHaveBeenCalled();
  });
});

describe("M27 platform availability", () => {
  it("reports configured YouTube and keeps Instagram unavailable", () => {
    const publishing = service({}, { socialAccounts: { youtubeConfigured: () => true } });
    expect(publishing.platforms()).toEqual([
      { platform: "YOUTUBE", connectable: true, publishable: true, reasonCode: null },
      {
        platform: "INSTAGRAM",
        connectable: false,
        publishable: false,
        reasonCode: "INSTAGRAM_NOT_VERIFIED",
      },
    ]);
  });
  it("keeps unconfigured YouTube unavailable", () => {
    const publishing = service({}, { socialAccounts: { youtubeConfigured: () => false } });
    expect(publishing.platforms()[0]).toMatchObject({ connectable: false, publishable: false });
  });
});

describe("M27 post creation replay", () => {
  const request = {
    clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    channelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    renderJobId,
    qualityReviewRunId: reviewId,
    scheduledAt: null,
    disclosure: { decision: "NOT_REQUIRED", reason: "No promotion" },
    destinations: [
      {
        platform: "YOUTUBE",
        socialAccountId: accountId,
        metadata: {
          platform: "YOUTUBE",
          title: "Title",
          description: "",
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
        },
      },
    ],
  };
  it("returns the original on replay and rejects a changed payload", async () => {
    let persisted: { id: string; clientRequestHash: string } | null = null;
    const created = { id: scheduledPostId } as ScheduledPostView;
    const findUnique = vi.fn(async () => persisted);
    const create = vi.fn(async ({ data }: { data: { clientRequestHash: string } }) => {
      persisted = { id: scheduledPostId, clientRequestHash: data.clientRequestHash };
      return { id: scheduledPostId };
    });
    const db = {
      scheduledPost: { findUnique },
      channel: {
        findUnique: vi.fn().mockResolvedValue({ id: request.channelId, status: "ACTIVE" }),
      },
      renderJob: {
        findUnique: vi.fn().mockResolvedValue({ sceneMediaJob: { channelId: request.channelId } }),
      },
      qualityReviewRun: { findUnique: vi.fn().mockResolvedValue({ renderJobId }) },
      socialAccount: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ channelId: request.channelId, platform: "YOUTUBE" }),
      },
      $transaction: async (callback: (tx: object) => Promise<unknown>): Promise<unknown> =>
        callback({
          scheduledPost: { create },
          publishingDestination: { create: async () => ({ id: destinationId }) },
          publishJob: { create: async () => ({}) },
        }),
    };
    const assertPublishable = vi.fn().mockResolvedValue([]);
    const publishing = service(db, { quality: { assertPublishable } });
    vi.spyOn(publishing, "getScheduledPost").mockResolvedValue(created);
    expect(await publishing.createScheduledPost(context(), request)).toBe(created);
    const replay = vi.fn();
    expect(await publishing.createScheduledPost(context(), request, replay)).toBe(created);
    expect(replay).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(assertPublishable).toHaveBeenCalledOnce();
    await expect(
      publishing.createScheduledPost(context(), {
        ...request,
        disclosure: { decision: "NOT_REQUIRED", reason: "Changed" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("recovers from a concurrent create unique violation by re-reading the original", async () => {
    const created = { id: scheduledPostId } as ScheduledPostView;
    let persisted: { id: string; clientRequestHash: string } | null = null;
    const findUnique = vi.fn(async () => persisted);
    const create = vi.fn(async ({ data }: { data: { clientRequestHash: string } }) => {
      persisted = { id: scheduledPostId, clientRequestHash: data.clientRequestHash };
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "7.10.1",
      });
    });
    const db = {
      scheduledPost: { findUnique },
      channel: {
        findUnique: vi.fn().mockResolvedValue({ id: request.channelId, status: "ACTIVE" }),
      },
      renderJob: {
        findUnique: vi.fn().mockResolvedValue({ sceneMediaJob: { channelId: request.channelId } }),
      },
      qualityReviewRun: { findUnique: vi.fn().mockResolvedValue({ renderJobId }) },
      socialAccount: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ channelId: request.channelId, platform: "YOUTUBE" }),
      },
      $transaction: async (callback: (tx: object) => Promise<unknown>): Promise<unknown> =>
        callback({
          scheduledPost: { create },
          publishingDestination: { create: async () => ({ id: destinationId }) },
          publishJob: { create: async () => ({}) },
        }),
    };
    const publishing = service(db, { quality: { assertPublishable: vi.fn().mockResolvedValue([]) } });
    vi.spyOn(publishing, "getScheduledPost").mockResolvedValue(created);
    const onReplay = vi.fn();
    expect(await publishing.createScheduledPost(context(), request, onReplay)).toBe(created);
    expect(create).toHaveBeenCalledOnce();
    expect(onReplay).toHaveBeenCalledOnce();
  });
});

describe("M27 draft listing", () => {
  it("scopes drafts to the workspace and validates cursors", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const publishing = service({ scheduledPost: { findMany } });
    await expect(publishing.drafts(context("VIEWER"))).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId, status: "DRAFT" }),
      }),
    );
    await expect(publishing.drafts(context(), "not-a-cursor")).rejects.toThrow("Invalid cursor");
  });
});

describe("M27 eligible render discovery", () => {
  const channelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const reviewedAt = new Date("2026-11-12T05:00:00.000Z");
  const input = {
    schemaVersion: "1.0",
    title: "Eligible render",
    profile: { transitionDurationMs: 0 },
    scenes: [{ durationMs: 5000 }],
  };
  function row(
    id: string,
    updatedAt: string,
    run: { id: string; status: string; createdAt: Date } | null,
  ): object {
    return {
      id,
      updatedAt: new Date(updatedAt),
      input,
      sceneMediaJob: { channelId, scriptId: projectId },
      artifacts: [{ id: `artifact-${id}` }],
      qualityReviewRuns: run === null ? [] : [run],
    };
  }
  const approvedRow = row(
    "11111111-1111-4111-8111-111111111111",
    "2026-11-12T06:00:00.000Z",
    { id: reviewId, status: "APPROVED", createdAt: reviewedAt },
  );
  const autoRow = row(
    "22222222-2222-4222-8222-222222222222",
    "2026-11-12T05:30:00.000Z",
    { id: "99999999-9999-4999-8999-999999999999", status: "AUTO_APPROVED", createdAt: reviewedAt },
  );
  const pendingRow = row(
    "33333333-3333-4333-8333-333333333333",
    "2026-11-12T05:15:00.000Z",
    { id: reviewId, status: "REVIEW_REQUIRED", createdAt: reviewedAt },
  );
  const rejectedRow = row(
    "44444444-4444-4444-8444-444444444444",
    "2026-11-12T05:10:00.000Z",
    { id: reviewId, status: "REJECTED", createdAt: reviewedAt },
  );
  const supersededRow = row(
    "55555555-5555-4555-8555-555555555555",
    "2026-11-12T05:05:00.000Z",
    null,
  );

  it("returns only current approved and auto-approved runs", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([approvedRow, autoRow, pendingRow, rejectedRow, supersededRow]);
    const publishing = service({ renderJob: { findMany } });
    const page = await publishing.eligibleRenders(context("VIEWER"), {});
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        renderJobId: "11111111-1111-4111-8111-111111111111",
        channelId,
        projectId,
        title: "Eligible render",
        durationMs: 5000,
        completedAt: "2026-11-12T06:00:00.000Z",
        qualityReviewRunId: reviewId,
        reviewStatus: "APPROVED",
        reviewedAt: reviewedAt.toISOString(),
      },
      {
        renderJobId: "22222222-2222-4222-8222-222222222222",
        channelId,
        projectId,
        title: "Eligible render",
        durationMs: 5000,
        completedAt: "2026-11-12T05:30:00.000Z",
        qualityReviewRunId: "99999999-9999-4999-8999-999999999999",
        reviewStatus: "AUTO_APPROVED",
        reviewedAt: reviewedAt.toISOString(),
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId,
          status: "SUCCEEDED",
          expiredAt: null,
          qualityReviewRuns: {
            some: expect.objectContaining({
              workspaceId,
              supersededAt: null,
              status: { in: ["APPROVED", "AUTO_APPROVED"] },
            }),
          },
        }),
      }),
    );
  });

  it("excludes an older approval once a newer review replaces it", async () => {
    const replaced = row(
      "66666666-6666-4666-8666-666666666666",
      "2026-11-12T06:00:00.000Z",
      { id: reviewId, status: "REJECTED", createdAt: reviewedAt },
    );
    const publishing = service({ renderJob: { findMany: vi.fn().mockResolvedValue([replaced]) } });
    await expect(publishing.eligibleRenders(context(), {})).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("scopes the optional channel filter and hides another workspace's channel", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(null);
    const publishing = service({ channel: { findUnique }, renderJob: { findMany } });
    await expect(publishing.eligibleRenders(context(), { channelId })).rejects.toThrow(
      "Channel not found",
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: channelId } },
      select: { id: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("pages by completed time and id without repeating the boundary", async () => {
    const findMany = vi.fn().mockResolvedValue([approvedRow, autoRow]);
    const publishing = service({ renderJob: { findMany } });
    const first = await publishing.eligibleRenders(context(), { limit: "1" });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    findMany.mockResolvedValue([autoRow]);
    const second = await publishing.eligibleRenders(context(), {
      limit: "1",
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.items).toHaveLength(1);
    const where = findMany.mock.calls[1]?.[0]?.where as {
      OR?: Array<Record<string, unknown>>;
    };
    expect(where.OR).toEqual([
      { updatedAt: { lt: new Date("2026-11-12T06:00:00.000Z") } },
      { updatedAt: new Date("2026-11-12T06:00:00.000Z"), id: { lt: "11111111-1111-4111-8111-111111111111" } },
    ]);
  });
});
