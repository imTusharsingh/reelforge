import { UnauthorizedException } from "@nestjs/common";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rejectedYouTubeInsert, ScheduledYouTube } from "../social-accounts/scheduled-youtube.js";
import { automationFixture, context, id } from "./automation.fixture.js";
import type { ScheduledPostView } from "./publishing.types.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-03-13T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("does not use a grace-window partial probe to miss the slot when its response arrives after cutoff", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
  const destination = post.destinations[0]!;
  f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "DISPATCHED" });
  f.db.publishingDestination.findUnique.mockResolvedValue({
    status: "FAILED_RETRYABLE",
    remotePostId: null,
  });
  f.db.publishAttempt.findFirst.mockResolvedValue({
    id: id(12),
    status: "FAILED_RETRYABLE",
    confirmedBytes: 3n,
    sessionCiphertext: "session",
    remotePostId: null,
  });
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  f.publishing.reconcile
    .mockImplementationOnce(async (_context, _id, onPartial) => {
      const startedAt = Date.now();
      entered.resolve();
      await pending.promise;
      onPartial?.({ attemptId: id(12), startedAt, nextByte: 3 });
      return { ...post, destinations: [{ ...destination, status: "FAILED_RETRYABLE" }] };
    })
    .mockResolvedValueOnce(published(post));
  vi.setSystemTime(f.slot.scheduledAt.getTime() + 60_000);
  const old = f.service.tick(new Date());
  await entered.promise;
  vi.setSystemTime(f.slot.scheduledAt.getTime() + 181_000);
  pending.resolve();
  await old;
  expect(f.slot.status).toBe("WAITING");
  await f.service.tick(new Date());
  expect(f.slot.status).toBe("COMPLETE");
  expect(f.run.state).toBe("PUBLISHED");
  expect(f.publishing.retry).not.toHaveBeenCalled();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "verified completion wins over a reconnect hold (failure first: %s)",
  async (failureFirst) => {
    const f = automationFixture();
    await f.service.dispatch(context, f.run.id);
    const post = await f.publishing.getScheduledPost(context, f.slot.scheduledPostId!);
    const response = Promise.withResolvers<ScheduledPostView>();
    const entered = Promise.withResolvers<void>();
    f.publishing.reconcile.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const verified = f.service.dispatch(context, f.run.id);
    await entered.promise;
    const reject = (): Promise<void> => {
      f.publishing.reconcile.mockRejectedValueOnce(
        new UnauthorizedException("YOUTUBE_RECONNECT_REQUIRED"),
      );
      return f.service.dispatch(context, f.run.id);
    };
    if (failureFirst) {
      await reject();
      expect(f.run.state).toBe("NEEDS_HUMAN");
      expect(f.slot.status).toBe("NEEDS_HUMAN");
    }
    if (!failureFirst) {
      const failed = Promise.withResolvers<ScheduledPostView>();
      const failing = Promise.withResolvers<void>();
      f.publishing.reconcile.mockImplementationOnce(() => {
        failing.resolve();
        return failed.promise;
      });
      const late = f.service.dispatch(context, f.run.id);
      await failing.promise;
      response.resolve(published(post));
      await verified;
      failed.reject(new UnauthorizedException("YOUTUBE_RECONNECT_REQUIRED"));
      await late;
    } else {
      response.resolve(published(post));
      await verified;
    }
    expect(f.slot).toMatchObject({ status: "COMPLETE", lastError: null });
    expect(f.run).toMatchObject({ state: "PUBLISHED", pauseReason: null });
    expect(f.publishing.publishNow).toHaveBeenCalledOnce();
  },
);

it("recovers a reconnect hold from a durable publication when the successful worker never updates the slot", async () => {
  const f = automationFixture();
  await f.service.dispatch(context, f.run.id);
  f.publishing.reconcile.mockRejectedValueOnce(
    new UnauthorizedException("YOUTUBE_RECONNECT_REQUIRED"),
  );
  await f.service.dispatch(context, f.run.id);
  expect(f.run.state).toBe("NEEDS_HUMAN");
  expect(f.slot.status).toBe("NEEDS_HUMAN");
  // The matching scheduled post is durably public, but the worker died before recording COMPLETE.
  f.db.v9PublishSlot.findFirst.mockResolvedValueOnce(f.slot);
  await f.service.tick(new Date());
  expect(f.slot).toMatchObject({ status: "COMPLETE", lastError: null });
  expect(f.run).toMatchObject({ state: "PUBLISHED", pauseReason: null });
  expect(f.publishing.reconcile).toHaveBeenCalledOnce();
  expect(f.publishing.publishNow).toHaveBeenCalledOnce();
});

it("records an elapsed definitive insert rejection as missed without refunding its consumed quota", async () => {
  const f = automationFixture();
  const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
  const youtube = new ScheduledYouTube(provider);
  f.publishing.publishNow.mockImplementationOnce(async () => {
    try {
      await youtube.start(
        "fixture-token",
        {
          platform: "YOUTUBE",
          title: "Fixture",
          description: "",
          tags: [],
          privacyStatus: "private",
          selfDeclaredMadeForKids: false,
        },
        f.slot.scheduledAt.toISOString(),
        12,
        "video/mp4",
      );
    } catch (error) {
      expect(error).toMatchObject({ detail: { code: rejectedYouTubeInsert } });
      f.db.v9InsertLease.findUnique.mockResolvedValue({ status: "CONSUMED" });
      f.db.publishingDestination.findUnique.mockResolvedValue({
        status: "FAILED_FINAL",
        lastErrorCode: rejectedYouTubeInsert,
        remotePostId: null,
      });
      f.db.publishAttempt.findFirst.mockResolvedValue({
        status: "FAILED_FINAL",
        errorCode: rejectedYouTubeInsert,
        sessionCiphertext: null,
        remotePostId: null,
      });
      throw error;
    }
    throw new Error("Expected simulated insert rejection");
  });
  await f.service.dispatch(context, f.run.id);
  expect(f.run.state).toBe("NEEDS_HUMAN");
  vi.setSystemTime(f.slot.scheduledAt.getTime() + 1);
  await f.service.retry(context, f.run.id);
  expect(f.slot).toMatchObject({ status: "MISSED", lastError: "YOUTUBE_SLOT_MISSED" });
  expect(await f.db.v9InsertLease.findUnique()).toEqual({ status: "CONSUMED" });
  expect(f.publishing.reconcile).not.toHaveBeenCalled();
  expect(provider).toHaveBeenCalledOnce();
});

function published(post: ScheduledPostView): ScheduledPostView {
  return {
    ...post,
    destinations: [{ ...post.destinations[0]!, status: "PUBLISHED", remotePostId: "same-video" }],
  };
}
