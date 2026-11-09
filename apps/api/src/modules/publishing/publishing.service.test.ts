import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PrismaClient } from "@reelforge/database";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionService } from "../composition/composition.service.js";
import type { QualityService } from "../quality/quality.service.js";
import type { SocialAccountsService } from "../social-accounts/social-accounts.service.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { ScheduledPostView } from "./publishing.types.js";
import {
  UnconfiguredPublishingBudgetPort,
  UnconfiguredPublishingSchedulePort,
} from "./publishing.ports.js";
import { PublishingService } from "./publishing.service.js";
import { PublishingSessionVault } from "./publishing-session-vault.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const scheduledPostId = "33333333-3333-4333-8333-333333333333";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");

function context(role: WorkspaceContext["role"] = "OWNER", id = workspaceId): WorkspaceContext {
  return { workspaceId: id, userId, role };
}

function service(db: object): PublishingService {
  return new PublishingService(
    db as PrismaClient,
    {} as CompositionService,
    {} as QualityService,
    {} as SocialAccountsService,
    {} as StoragePort,
    new UnconfiguredPublishingSchedulePort(),
    new UnconfiguredPublishingBudgetPort(),
    new PublishingSessionVault(encryptionKey),
  );
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
