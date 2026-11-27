import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { automationFixture, context } from "./automation.fixture.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-03-13T00:00:00Z"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("V9 approved-run publishing with fake M13/YouTube", () => {
  it("creates one cadence post with disclosure and never uploads twice", async () => {
    const f = automationFixture();
    await f.service.dispatch(context, f.run.id);
    await f.service.dispatch(context, f.run.id);
    expect(f.publishing.createScheduledPost).toHaveBeenCalledTimes(1);
    expect(f.publishing.publishNow).toHaveBeenCalledTimes(1);
    expect(f.publishing.reconcile).toHaveBeenCalledTimes(1);
    expect(f.publishing.createScheduledPost.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: f.run.id,
      scheduledAt: f.slot.scheduledAt.toISOString(),
      disclosure: { decision: "DISCLOSE" },
      destinations: [{ metadata: { privacyStatus: "private", title: "Science" } }],
    });
  });
  it("blocks missing approvals, gate fallback and first-ten auto publish", async () => {
    for (const level of ["L1", "L2", "L3"] as const) {
      const f = automationFixture();
      f.run.effectiveAutonomy = level;
      f.scoped.runEvent.findFirst.mockResolvedValue(null);
      await expect(f.service.prepare(context, f.run.id)).rejects.toThrow("approval");
      expect(f.publishing.publishNow).not.toHaveBeenCalled();
    }
    const f = automationFixture();
    f.run.effectiveAutonomy = "L3";
    f.scoped.runEvent.findFirst.mockResolvedValue({ type: "auto_approved" });
    await expect(f.service.prepare(context, f.run.id)).rejects.toThrow("first ten");
    f.run.approvedShortsAtStart = 10;
    await expect(f.service.prepare(context, f.run.id)).resolves.toMatchObject({
      scheduledPostId: expect.any(String),
    });
    f.run.effectiveAutonomy = "L2";
    await expect(f.service.prepare(context, f.run.id)).rejects.toThrow("first ten");
  });
  it("puts revoked OAuth in NEEDS_HUMAN and never creates a duplicate upload", async () => {
    const f = automationFixture();
    f.publishing.publishNow.mockRejectedValueOnce(
      new UnauthorizedException("YOUTUBE_RECONNECT_REQUIRED"),
    );
    await f.service.dispatch(context, f.run.id);
    expect(f.run.state).toBe("NEEDS_HUMAN");
    expect(f.run.pauseReason).toBe("RECONNECT_YOUTUBE");
    expect(f.slot.lastError).toBe("RECONNECT_YOUTUBE");
    await f.service.dispatch(context, f.run.id);
    expect(f.publishing.publishNow).toHaveBeenCalledTimes(1);
  });
  it("fails closed on disabled pipeline, viewers and unresolved holds", async () => {
    const f = automationFixture();
    await expect(f.service.prepare({ ...context, role: "VIEWER" }, f.run.id)).rejects.toThrow(
      "Editor",
    );
    f.run.pauseReason = "GATE_FAILED";
    await expect(f.service.prepare(context, f.run.id)).rejects.toThrow("approval");
  });
  it("marks a dry-run result on both the schedule and the review run", async () => {
    const f = automationFixture();
    const post = await f.publishing.getScheduledPost(context, f.run.id);
    f.publishing.publishNow.mockResolvedValueOnce({
      ...post,
      dryRun: true,
      destinations: [{ ...post.destinations[0]!, status: "PUBLISHED", remotePostId: null }],
    });
    await f.service.dispatch(context, f.run.id);
    expect(f.slot.status).toBe("DRY_RUN");
    expect(f.run).toMatchObject({ state: "PUBLISHED", pauseReason: "PUBLISH_DRY_RUN" });
    await f.service.dispatch(context, f.run.id);
    expect(f.publishing.publishNow).toHaveBeenCalledOnce();
  });
  it("reconciles a partial upload before resuming and records public publication", async () => {
    const f = automationFixture();
    await f.service.dispatch(context, f.run.id);
    const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
    f.publishing.reconcile.mockResolvedValueOnce({
      ...post,
      destinations: [{ ...post.destinations[0]!, status: "FAILED_RETRYABLE" }],
    });
    f.publishing.retry.mockResolvedValueOnce({
      ...post,
      destinations: [{ ...post.destinations[0]!, status: "PUBLISHED" }],
    });
    await f.service.dispatch(context, f.run.id);
    expect(f.publishing.retry).toHaveBeenCalledTimes(1);
    expect(f.run.state).toBe("PUBLISHED");
    expect(f.slot.status).toBe("COMPLETE");
  });
});

it("marks a missed unused slot without sending a new upload", async () => {
  const f = automationFixture();
  vi.setSystemTime(f.slot.scheduledAt);
  await f.service.dispatch(context, f.run.id);
  await f.service.dispatch(context, f.run.id);
  expect(f.publishing.publishNow).not.toHaveBeenCalled();
  expect(f.publishing.reconcile).not.toHaveBeenCalled();
  expect(f.slot).toMatchObject({ status: "MISSED", lastError: "YOUTUBE_SLOT_MISSED" });
  expect(f.run.state).toBe("SCHEDULED");
});

it("only reads a previously submitted upload after its slot and never resumes an incomplete one", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "DISPATCHED" });
  f.db.publishingDestination.findUnique.mockResolvedValue({
    status: "FAILED_RETRYABLE",
    remotePostId: null,
  });
  f.db.publishAttempt.findFirst.mockResolvedValue({
    status: "FAILED_RETRYABLE",
    sessionCiphertext: "session",
    remotePostId: null,
  });
  vi.setSystemTime(new Date(f.slot.scheduledAt.getTime() + 180_000));
  const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
  f.publishing.reconcile.mockResolvedValueOnce({
    ...post,
    destinations: [{ ...post.destinations[0]!, status: "FAILED_RETRYABLE" }],
  });
  await f.service.dispatch(context, f.run.id);
  expect(f.publishing.reconcile).toHaveBeenCalledOnce();
  expect(f.publishing.retry).not.toHaveBeenCalled();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
  expect(f.slot).toMatchObject({ status: "MISSED", lastError: "YOUTUBE_SLOT_MISSED" });
});

it("finishes the run on a later tick if slot completion was already committed", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
  f.publishing.reconcile.mockResolvedValueOnce({
    ...post,
    destinations: [{ ...post.destinations[0]!, status: "PUBLISHED" }],
  });
  f.transition.mockRejectedValueOnce(new Error("database not connected during transition"));
  await f.service.dispatch(context, f.run.id);
  expect(f.slot.status).toBe("COMPLETE");
  expect(f.run.state).toBe("SCHEDULED");
  await f.service.tick(new Date());
  expect(f.run.state).toBe("PUBLISHED");
  expect(f.transition).toHaveBeenCalledTimes(2);
  expect(f.publishing.reconcile).toHaveBeenCalledOnce();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
});

it("reconciles a claimed upload when a stale no-attempt read returns after the deadline", async () => {
  const f = automationFixture();
  const stale = await f.publishing.getScheduledPost(context, f.run.id);
  const release = Promise.withResolvers<typeof stale>();
  const entered = Promise.withResolvers<void>();
  f.publishing.getScheduledPost.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const staleDispatch = f.service.dispatch(context, f.run.id);
  await entered.promise;
  expect(stale.destinations[0]?.latestAttempt).toBeNull();

  const uploadEntered = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<typeof stale>();
  f.publishing.publishNow.mockImplementationOnce(() => {
    f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "DISPATCHED" });
    f.db.publishAttempt.findFirst.mockResolvedValue({
      status: "UPLOADING",
      sessionCiphertext: "session",
      remotePostId: null,
    });
    uploadEntered.resolve();
    return upload.promise;
  });
  const dispatchWithUpload = f.service.dispatch(context, f.run.id);
  await uploadEntered.promise;
  vi.setSystemTime(f.slot.scheduledAt);
  release.resolve(stale);
  await staleDispatch;
  expect(f.publishing.reconcile).toHaveBeenCalledOnce();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
  expect(f.slot.status).toBe("WAITING");
  upload.resolve(stale);
  await dispatchWithUpload;
  expect(f.slot.status).toBe("WAITING");
});

it("marks a crashed claim with only a reserved insert lease missed", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "RESERVED" });
  f.db.publishAttempt.findFirst.mockResolvedValue({
    status: "STARTED",
    sessionCiphertext: null,
    remotePostId: null,
  });
  vi.setSystemTime(f.slot.scheduledAt);
  await f.service.dispatch(context, f.run.id);
  expect(f.slot).toMatchObject({ status: "MISSED", lastError: "YOUTUBE_SLOT_MISSED" });
  expect(f.publishing.reconcile).not.toHaveBeenCalled();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
});

it("reads but does not resume a partial upload during grace, then publishes its same video", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "DISPATCHED" });
  f.db.publishingDestination.findUnique.mockResolvedValue({
    status: "FAILED_RETRYABLE",
    remotePostId: null,
  });
  f.db.publishAttempt.findFirst.mockResolvedValue({
    status: "FAILED_RETRYABLE",
    sessionCiphertext: "session",
    remotePostId: null,
  });
  const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
  const destination = post.destinations[0]!;
  const videoId = destination.latestAttempt!.remotePostId;
  f.publishing.reconcile
    .mockResolvedValueOnce({
      ...post,
      destinations: [{ ...destination, status: "FAILED_RETRYABLE" }],
    })
    .mockResolvedValueOnce({
      ...post,
      destinations: [{ ...destination, status: "PUBLISHED", remotePostId: videoId }],
    });
  vi.setSystemTime(new Date(f.slot.scheduledAt.getTime() + 60_000));
  await f.service.tick(new Date());
  expect(f.slot.status).toBe("WAITING");
  expect(f.publishing.retry).not.toHaveBeenCalled();
  vi.setSystemTime(new Date(f.slot.scheduledAt.getTime() + 90_000));
  await f.service.tick(new Date());
  expect(f.slot.status).toBe("COMPLETE");
  expect(f.run.state).toBe("PUBLISHED");
  expect(f.publishing.reconcile).toHaveBeenNthCalledWith(2, context, destination.id);
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
  expect(f.publishing.retry).not.toHaveBeenCalled();
});
