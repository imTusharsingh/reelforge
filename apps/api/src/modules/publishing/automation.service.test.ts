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
