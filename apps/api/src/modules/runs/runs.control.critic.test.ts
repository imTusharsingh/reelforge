import { describe, expect, it, vi } from "vitest";
import { RunsControl } from "./runs.control.js";
import type { RunsService } from "./runs.service.js";
import type { RunsBoundary } from "./runs.boundary.js";
import type { Context } from "./runs.types.js";

const context: Context = { workspaceId: "w", userId: "u", role: "OWNER" };
describe("critic controls", () => {
  it("rejects approval when the persisted critic report is missing", async () => {
    const updateMany = vi.fn();
    const run = { id: "r", state: "AWAITING_APPROVAL", pauseReason: null };
    const transaction = {
      videoRunStep: { findFirst: async (): Promise<null> => null },
      videoRun: { updateMany },
    };
    const runs = {
      editor: vi.fn(),
      store: {
        get: async () => run,
        mutate: async (
          _context: unknown,
          _id: unknown,
          _event: unknown,
          callback: (db: typeof transaction, current: typeof run) => Promise<unknown>,
        ) => callback(transaction, run),
      },
    } as unknown as RunsService;
    const control = new RunsControl(runs, {
      check: async () => undefined,
    } as unknown as RunsBoundary);
    await expect(control.approve(context, "r")).rejects.toThrow("Approval requires all hard gates");
    expect(updateMany).not.toHaveBeenCalled();
  });
  it("moves a cap-exhausted shot to human review without creating another attempt", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn();
    const run = { id: "r", state: "CRITIC", effectiveAutonomy: "L3" };
    const transaction = {
      videoRunStep: {
        findFirstOrThrow: async (): Promise<{ attempt: number }> => ({ attempt: 3 }),
        create,
      },
      budgetEnvelope: { findFirstOrThrow: async (): Promise<object> => ({}) },
      videoRun: { updateMany },
    };
    const runs = {
      editor: vi.fn(),
      store: {
        get: async () => run,
        mutate: async (
          _context: unknown,
          _id: unknown,
          _event: unknown,
          callback: (db: typeof transaction, current: typeof run) => Promise<{ value: boolean }>,
        ) => ({ ...(await callback(transaction, run)), event: {} }),
      },
    } as unknown as RunsService;
    const control = new RunsControl(runs, {
      check: async () => undefined,
    } as unknown as RunsBoundary);
    await control.reshoot(context, "r", 0);
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "NEEDS_HUMAN", effectiveAutonomy: "L2" }),
      }),
    );
  });
});
