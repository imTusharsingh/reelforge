import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AutonomyController } from "./autonomy.controller.js";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
import { context, fixture } from "./autonomy.fixture.js";
const req = { principal: { userId: context.userId } } as AuthenticatedRequest;
describe("V8 HTTP trust boundary", () => {
  it("validates UUID/body and uses verified membership context", async () => {
    const f = fixture();
    const verify = vi.fn(async () => context);
    const controller = new AutonomyController(f.service, {
      context: verify,
    } as unknown as WorkspaceService);
    await expect(controller.decide(req, "bad", f.run.id, { decision: "APPROVE" })).rejects.toThrow(
      "Invalid UUID",
    );
    await expect(
      controller.decide(req, context.workspaceId, f.run.id, { decision: "bad" }),
    ).rejects.toThrow();
    await expect(
      controller.select(req, context.workspaceId, f.run.id, { requested: "L4" }),
    ).rejects.toThrow();
    await controller.decide(req, context.workspaceId, f.run.id, { decision: "REJECT" });
    expect(verify).toHaveBeenCalledWith(context.userId, context.workspaceId);
    expect(f.service.store.scoped).toHaveBeenCalledWith(context);
    verify.mockRejectedValueOnce(new Error("Workspace access denied"));
    await expect(controller.status(req, context.workspaceId, f.run.id)).rejects.toThrow(
      "Workspace access denied",
    );
  });
  it("returns channel autonomy status, run list and workspace-scoped usage", async () => {
    const f = fixture();
    const db = f.service.store.scoped(context);
    Object.assign(db.videoRun, { findMany: vi.fn(async () => [f.run]) });
    Object.assign(db.videoRunStep, {
      groupBy: vi
        .fn()
        .mockResolvedValueOnce([{ runId: f.run.id, _sum: { costMinor: 579 } }])
        .mockResolvedValueOnce([{ providerId: null, _sum: { costMinor: null } }]),
    });
    const controller = new AutonomyController(f.service, {
      context: vi.fn(async () => context),
    } as unknown as WorkspaceService);
    expect(await controller.list(req, context.workspaceId)).toEqual([f.run]);
    expect(await controller.status(req, context.workspaceId, f.run.id)).toMatchObject({
      effective: "L2",
      offerL3: false,
    });
    expect(await controller.usage(req, context.workspaceId)).toEqual({
      shorts: [{ runId: f.run.id, costMinor: 579 }],
      providers: [{ providerId: "unattributed", costMinor: 0 }],
    });
    f.run.state = "PLANNING";
    await controller.select(req, context.workspaceId, f.run.id, { requested: "L1" });
    expect(f.run.effectiveAutonomy).toBe("L1");
  });
});
