import { describe, expect, it, vi } from "vitest";
import type { Context, Run } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import type { MediaPlanning } from "../scene-media/media-planning.js";
import type { MediaRenderer } from "./media-render.js";
import { MediaAssembly } from "./media-assembly.js";

describe("assembly retries", () => {
  it("does not reuse an earlier assembly after a shot reshoot", async () => {
    const count = vi.fn(async () => 1);
    const findFirst = vi.fn(async () => null);
    const access = {
      runs: { store: { scoped: () => ({ videoRunStep: { count, findFirst } }) } },
      artifacts: { descriptors: () => [] },
    } as unknown as MediaAccess;
    const service = new MediaAssembly(
      access,
      {} as MediaJobs,
      {} as MediaPorts,
      {} as MediaPlanning,
      {} as MediaRenderer,
    );
    await expect(
      service.artifacts({ workspaceId: "w" } as Context, { id: "r" } as Run),
    ).resolves.toEqual([]);
    expect(count).toHaveBeenCalledWith({
      where: {
        runId: "r",
        OR: [{ key: { startsWith: "shot-" }, attempt: { gt: 1 } }, { key: "REEDIT" }],
      },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { runId: "r", key: "local:assembly", state: "SUCCEEDED", attempt: 2 },
    });
  });
});
