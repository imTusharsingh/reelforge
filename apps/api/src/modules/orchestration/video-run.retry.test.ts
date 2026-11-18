import { describe, expect, it, vi } from "vitest";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Run } from "../runs/runs.types.js";
import { RunPlanning } from "./video-run.planning.js";
import { criticPassed } from "./video-run.engine.js";
import type { RunOutputs } from "./video-run.outputs.js";
import type { RunsBoundary } from "../runs/runs.boundary.js";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import type { RunGeneration } from "./video-run.generation.js";
import { VideoRunEngine } from "./video-run.engine.js";

const context = { workspaceId: "workspace", userId: "user", role: "OWNER" } as Context;

describe("run stage attempts", () => {
  it("requires an explicit critic result before allowing approval", () => {
    expect(() => criticPassed({ result: {} })).toThrow("Validated critic result is required");
    expect(criticPassed({ result: { criticPassed: false } })).toBe(false);
    expect(criticPassed({ result: { criticPassed: true } })).toBe(true);
  });
  it("moves a failed critic result to human review instead of approval", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    try {
      const id = "11111111-1111-4111-8111-111111111111";
      const run = { id, workspaceId: id, correlationId: id, state: "CRITIC" };
      const move = vi.fn(async () => undefined);
      const enqueue = vi.fn();
      const runs = {
        store: {
          db: { workspaceMembership: { findFirst: async () => ({ role: "OWNER" }) } },
          get: async () => run,
        },
        move,
        enqueue,
      } as unknown as RunsService;
      const planning = {
        reedit: async () => undefined,
        stage: async () => ({ state: "SUCCEEDED", output: { result: { criticPassed: false } } }),
      } as unknown as RunPlanning;
      const engine = new VideoRunEngine(
        runs,
        { check: async () => undefined } as unknown as RunsBoundary,
        {} as RunGeneration,
        planning,
        {} as RunsArtifacts,
      );
      await engine.process({ workspaceId: id, userId: id, runId: id });
      expect(move).toHaveBeenCalledWith(
        expect.anything(),
        run,
        "NEEDS_HUMAN",
        "Critic gate failed",
      );
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(["ASSEMBLING", "CRITIC"])("uses a fresh %s attempt for each reshoot", async (state) => {
    const findFirst = vi.fn(async () => ({ state: "SUCCEEDED" }));
    const count = vi.fn(async () => 2);
    const db = { videoRunStep: { findFirst, count } };
    const runs = { store: { scoped: () => db } } as unknown as RunsService;
    const planning = new RunPlanning(runs, {} as RunOutputs);
    await planning.stage(context, { id: "run", state } as Run);
    expect(count).toHaveBeenCalledWith({
      where: { runId: "run", key: { startsWith: "shot-" }, attempt: { gt: 1 } },
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { runId: "run", key: state, attempt: 3 } });
  });
});
