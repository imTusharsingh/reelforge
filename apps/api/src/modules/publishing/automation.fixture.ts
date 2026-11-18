import "reflect-metadata";
import { vi, type Mock } from "vitest";
import type { PrismaClient } from "@reelforge/database";
import type { Context, Run, Scoped, Json } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import { PublishingAutomation } from "./automation.service.js";
import { AutomationSlots, type AutoSlot } from "./automation-slots.js";
import type { PublishingService } from "./publishing.service.js";
import type { ScheduledPostView } from "./publishing.types.js";
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const context: Context = { workspaceId: id(1), userId: id(2), role: "OWNER" };
export const packaged = {
  renderJobId: id(5),
  qualityReviewRunId: id(6),
  title: "Science",
  description: "An original short",
  tags: ["science"],
  coverFrame: "cover.png",
  containsSyntheticMedia: true as const,
};
export const criticStep = {
  id: id(12),
  state: "SUCCEEDED",
  output: {
    result: {
      recommendation: "APPROVE",
      summary: "Ready",
      gates: {
        policy: true,
        rights: true,
        technical: true,
        budget: true,
        permission: true,
        score: true,
      },
    },
  },
};
export function automationFixture(): {
  service: PublishingAutomation;
  run: Run;
  slot: AutoSlot;
  scoped: ReturnType<typeof scopedFake>;
  db: ReturnType<typeof databaseFake>;
  publishing: ReturnType<typeof publishingFake>;
} {
  const run = {
    id: id(3),
    workspaceId: id(1),
    channelId: id(4),
    channelBriefId: id(9),
    channelBriefVersion: 1,
    state: "SCHEDULED",
    pauseReason: null,
    effectiveAutonomy: "L2",
    approvedShortsAtStart: 0,
    revision: 1,
  } as Run;
  const slot = {
    id: id(7),
    workspaceId: id(1),
    runId: run.id,
    channelId: run.channelId,
    socialAccountId: id(8),
    scheduledPostId: null,
    scheduledAt: new Date("2027-03-14T07:00:00Z"),
    timezone: "America/New_York",
    package: packaged,
    status: "QUEUED",
    lastError: null,
    createdAt: new Date("2026-11-17T00:00:00Z"),
    schemaVersion: "1.0",
  } as AutoSlot;
  const scoped = scopedFake(run);
  const runs = {
    get: vi.fn(async () => run),
    scoped: vi.fn(() => scoped),
    mutate: vi.fn(
      async (
        _c: Context,
        _id: string,
        _type: string,
        work: (d: Scoped, r: Run) => Promise<{ payload: Json }>,
      ) => work(scoped as unknown as Scoped, run),
    ),
    transition: vi.fn(async () => {
      run.state = "PUBLISHED";
    }),
  } as unknown as RunsStore;
  const db = databaseFake(slot);
  const publishing = publishingFake();
  const slots = { reserve: vi.fn(async () => slot) } as unknown as AutomationSlots;
  return {
    service: new PublishingAutomation(
      db as unknown as PrismaClient,
      runs,
      slots,
      publishing as unknown as PublishingService,
    ),
    run,
    slot,
    scoped,
    db,
    publishing,
  };
}
function scopedFake(run: Run): {
  runEvent: { findFirst: ReturnType<typeof vi.fn> };
  videoRunStep: { findFirst: ReturnType<typeof vi.fn> };
  videoRun: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
} {
  return {
    runEvent: { findFirst: vi.fn(async () => ({ type: "approved", stepId: criticStep.id })) },
    videoRunStep: {
      findFirst: vi.fn(async ({ where }: { where: { key: string } }) =>
        where.key === "CRITIC" ? criticStep : { output: { result: packaged } },
      ),
    },
    videoRun: {
      updateMany: vi.fn(async ({ data }: { data: Partial<Run> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => [run]),
    },
  };
}
function databaseFake(slot: AutoSlot): {
  v9PublishSlot: { updateMany: ReturnType<typeof vi.fn> };
  workspace: { findMany: ReturnType<typeof vi.fn> };
  workspaceMembership: { findFirst: ReturnType<typeof vi.fn> };
} {
  return {
    v9PublishSlot: {
      updateMany: vi.fn(async ({ data }: { data: Partial<AutoSlot> }) => {
        Object.assign(slot, data);
        return { count: 1 };
      }),
    },
    workspace: { findMany: vi.fn(async () => [{ id: context.workspaceId }]) },
    workspaceMembership: {
      findFirst: vi.fn(async () => ({ userId: context.userId, role: "OWNER" })),
    },
  };
}
function publishingFake(): {
  createScheduledPost: Mock<(context: Context, body: unknown) => Promise<ScheduledPostView>>;
  getScheduledPost: Mock<(context: Context, id: string) => Promise<ScheduledPostView>>;
  publishNow: Mock<(context: Context, id: string) => Promise<ScheduledPostView>>;
  reconcile: Mock<(context: Context, id: string) => Promise<ScheduledPostView>>;
  retry: Mock<(context: Context, id: string) => Promise<ScheduledPostView>>;
} {
  let attempted = false;
  const post = (): ScheduledPostView => ({
    id: id(10),
    channelId: id(4),
    renderJobId: id(5),
    qualityReviewRunId: id(6),
    revision: 1,
    scheduledAt: "2027-03-14T07:00:00Z",
    status: "REMOTE_PROCESSING",
    disclosureDecision: "DISCLOSE",
    disclosureText: "AI-generated",
    disclosureReason: "AI disclosure",
    manuallyAuthorizedAt: null,
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
    destinations: [
      {
        id: id(11),
        platform: "YOUTUBE",
        socialAccountId: id(8),
        status: "REMOTE_PROCESSING",
        remotePostId: null,
        publishedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        metadata: {},
        idempotencyKey: id(11),
        latestAttempt: attempted
          ? {
              id: id(12),
              attemptNumber: 1,
              status: "REMOTE_PROCESSING",
              confirmedBytes: "128",
              totalBytes: "128",
              remotePostId: "fake-video",
              errorCode: null,
              errorMessage: null,
              startedAt: "2026-11-17T00:00:00Z",
              finishedAt: null,
            }
          : null,
      },
    ],
  });
  return {
    createScheduledPost: vi.fn(async () => post()),
    getScheduledPost: vi.fn(async () => post()),
    publishNow: vi.fn(async () => {
      attempted = true;
      return post();
    }),
    reconcile: vi.fn(async () => post()),
    retry: vi.fn(async () => post()),
  };
}
