import "reflect-metadata";
import { vi } from "vitest";
import { AutonomyService } from "./autonomy.service.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Scoped, Json } from "../runs/runs.types.js";
export const context: Context = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  role: "OWNER",
};
export const report = {
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
};
export function fixture(): {
  service: AutonomyService;
  run: Run;
  db: ReturnType<typeof fakeDb>;
  stop: { check: ReturnType<typeof vi.fn> };
} {
  const run = {
    id: "00000000-0000-4000-8000-000000000003",
    channelId: "00000000-0000-4000-8000-000000000004",
    workspaceId: context.workspaceId,
    state: "AWAITING_APPROVAL",
    effectiveAutonomy: "L2",
    requestedAutonomy: "L2",
    approvedShortsAtStart: 0,
    pauseReason: null,
  } as Run;
  const db = fakeDb(run);
  const store = {
    scoped: vi.fn(() => db),
    get: vi.fn(async () => run),
    mutate: vi.fn(
      async (
        _ctx: Context,
        _id: string,
        type: string,
        work: (scoped: Scoped, current: Run) => Promise<{ payload: Json; stepId?: string }>,
      ) => {
        const result = await work(db as unknown as Scoped, run);
        db.events.push({
          type,
          payload: result.payload,
          ...(result.stepId ? { stepId: result.stepId } : {}),
        });
        return result;
      },
    ),
  } as unknown as RunsStore;
  const stop = { check: vi.fn(async () => ({ stopped: false, scope: null, reason: null })) };
  return { service: new AutonomyService(store, stop), run, db, stop };
}
function fakeDb(run: Run): {
  events: Array<{ type: string; payload: Json; stepId?: string }>;
  runEvent: {
    count: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  videoRun: { updateMany: ReturnType<typeof vi.fn> };
  videoRunStep: { findFirst: ReturnType<typeof vi.fn> };
} {
  const events: Array<{ type: string; payload: Json; stepId?: string }> = [];
  return {
    events,
    runEvent: {
      count: vi.fn(async () => events.filter((e) => e.type === "approved").length),
      findFirst: vi.fn(
        async () =>
          events.find((e) => ["approved", "auto_approved", "human_rejected"].includes(e.type)) ??
          null,
      ),
      findMany: vi.fn(async () => events),
    },
    videoRun: {
      updateMany: vi.fn(async ({ data }: { data: Partial<Run> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    videoRunStep: {
      findFirst: vi.fn(async () => ({ id: "critic-step", output: { result: report } })),
    },
  };
}
