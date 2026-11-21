import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleRef } from "@nestjs/core";
import { MediaAssembly } from "../composition/media-assembly.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunsControl } from "../runs/runs.control.js";
import { RunsService } from "../runs/runs.service.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
import { context, planningFixture } from "../script/planning.fixture.js";
import { CriticStep } from "./critic.step.js";
import type { RunCritic } from "./run-critic.js";

const { brief, runId } = planningFixture();
const run = { id: runId, workspaceId: context.workspaceId } as Run;
const step = { attempt: 1 } as Step;
const originalShot = { id: "6d813f55-a72d-436b-9e35-a277ac7f1d03", attempt: 1, costMinor: 10 };
const report = {
  recommendation: "REJECT",
  summary: "fixture",
  gates: {
    policy: true,
    rights: true,
    technical: false,
    budget: true,
    permission: true,
    score: false,
  },
};

function fixture(
  attempts: Partial<Step>[] = [],
  spentMinor = 100,
): {
  handler: CriticStep;
  planning: { handlers: Record<string, unknown> };
  reshoot: ReturnType<typeof vi.fn>;
  reedit: ReturnType<typeof vi.fn>;
  execute: ReturnType<
    typeof vi.fn<() => { report: typeof report; redo: { shots: string[]; reedit: boolean } }>
  >;
  assemble: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const planning = { handlers: { ASSEMBLING: {} } };
  const reshoot = vi.fn();
  const reedit = vi.fn();
  const assemble = vi.fn(() => []);
  const db = {
    videoRunStep: {
      findMany: vi.fn(() => attempts),
      findFirst: vi.fn(() => null),
      findFirstOrThrow: vi.fn(() => originalShot),
      updateMany: vi.fn(),
      create: vi.fn(() => ({ id: "package" })),
    },
    budgetEnvelope: {
      findFirstOrThrow: (): {
        spentMinor: number;
        reservedMinor: number;
        hardCapMinor: number;
        baseEstimateMinor: number;
        reshootReserveMinor: number;
      } => ({
        spentMinor,
        reservedMinor: 0,
        hardCapMinor: 800,
        baseEstimateMinor: 600,
        reshootReserveMinor: 200,
      }),
    },
  };
  const runs = {
    store: {
      db: { workspaceMembership: { findFirst: (): Context => context } },
      scoped: (): typeof db => db,
      mutate: vi.fn(
        async (
          _context: Context,
          _id: string,
          _event: string,
          work: (scoped: typeof db, current: { state: string }) => Promise<unknown>,
        ) => work(db, { state: "CRITIC" }),
      ),
    },
  };
  const get = vi.fn((token: unknown) =>
    new Map<unknown, unknown>([
      [RunPlanning, planning],
      [RunsService, runs],
      [RunsControl, { reshoot, reedit }],
      [MediaAssembly, { execute: assemble }],
    ]).get(token),
  );
  const execute = vi.fn(() => ({ report, redo: { shots: ["0"], reedit: false } }));
  const handler = new CriticStep(
    { get } as unknown as ModuleRef,
    () => ({ execute }) as unknown as RunCritic,
  );
  return { handler, planning, reshoot, reedit, execute, assemble, get };
}

afterEach(() => vi.unstubAllEnvs());

describe("V3 critic registration", () => {
  it("registers one handler and defers advancement after requesting a V3 reshoot", async () => {
    const { handler, planning, reshoot } = fixture();
    handler.onModuleInit();
    expect(planning.handlers).toEqual({ ASSEMBLING: {}, CRITIC: handler });
    await expect(handler.execute(run, brief, step, context)).rejects.toThrow("deferred");
    expect(reshoot).toHaveBeenCalledWith(context, run.id, 0, originalShot.id);
  });

  it("reviews refreshed evidence and stops after two reshoots of a shot", async () => {
    const { handler, execute, reshoot, assemble } = fixture(
      [3, 2].map((attempt) => ({
        key: "shot-0",
        attempt,
        state: "SUCCEEDED",
        createdAt: new Date(),
      })),
    );
    await expect(handler.reconcile(run, brief, step, context)).resolves.toEqual(report);
    expect(assemble).toHaveBeenCalledWith(context, run, brief);
    expect(execute).toHaveBeenCalledWith(context, run, brief, step, 3);
    expect(reshoot).not.toHaveBeenCalled();
  });

  it("stops when the run cannot afford another shot and review", async () => {
    const { handler, reshoot } = fixture([], 799);
    await expect(handler.execute(run, brief, step, context)).resolves.toBeDefined();
    expect(reshoot).not.toHaveBeenCalled();
  });

  it("requests one V3 re-edit and respects an existing request", async () => {
    const first = fixture();
    first.execute.mockReturnValue({ report, redo: { shots: [], reedit: true } });
    await expect(first.handler.execute(run, brief, step, context)).rejects.toThrow("re-edit");
    expect(first.reedit).toHaveBeenCalledWith(context, run.id);
    const repeated = fixture([{ key: "REEDIT", state: "SUCCEEDED", createdAt: new Date() }]);
    repeated.execute.mockReturnValue({ report, redo: { shots: [], reedit: true } });
    await expect(repeated.handler.reconcile(run, brief, step, context)).resolves.toBeDefined();
    expect(repeated.reedit).not.toHaveBeenCalled();
  });
});
