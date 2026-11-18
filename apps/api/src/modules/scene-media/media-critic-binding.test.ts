import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { V6RunCritic } from "../quality/v6-run-critic.js";
import type { MediaAccess } from "./media-access.js";
import { MediaBindings } from "./media-pipeline.module.js";

describe("V6 worker binding", () => {
  it("registers and invokes V6 for the CRITIC stage", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    try {
      const critic = { execute: vi.fn(async () => ({ criticPassed: true })) };
      const generation = {};
      const planning = { handlers: {} };
      const outputs = {};
      const instances = new Map<unknown, unknown>([
        [RunGeneration, generation],
        [RunPlanning, planning],
        [RunOutputs, outputs],
        [V6RunCritic, critic],
      ]);
      const access = {
        modules: { get: (key: unknown) => instances.get(key) },
        runs: {
          store: {
            db: {
              workspaceMembership: { findFirst: async () => ({ userId: "user", role: "OWNER" }) },
            },
          },
        },
      } as unknown as MediaAccess;
      const bindings = new MediaBindings(
        access,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      bindings.onModuleInit();
      const handlers = planning.handlers as Record<
        string,
        { execute: (run: unknown, brief: unknown, step: unknown) => Promise<unknown> }
      >;
      const run = { id: "run", workspaceId: "workspace" };
      const brief = {};
      const step = { attempt: 1 };
      await expect(handlers.CRITIC!.execute(run, brief, step)).resolves.toEqual({
        criticPassed: true,
      });
      expect(critic.execute).toHaveBeenCalledWith(
        { workspaceId: "workspace", userId: "user", role: "OWNER" },
        run,
        brief,
        step,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
