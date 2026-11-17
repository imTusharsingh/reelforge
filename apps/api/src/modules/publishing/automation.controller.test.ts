import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reelforge/database";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
import { AutomationController } from "./automation.controller.js";
import { automationFixture, context } from "./automation.fixture.js";
afterEach(() => vi.unstubAllEnvs());
describe("V9 tenant-scoped automation HTTP", () => {
  it("uses verified tenant membership for reads and editor check for retry", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    const f = automationFixture();
    const db = {
      v9PublishSlot: {
        findMany: vi.fn(async () => [f.slot]),
        findFirst: vi.fn(async () => f.slot),
      },
    };
    const verify = vi.fn(async () => context);
    const req = { principal: { userId: context.userId } } as AuthenticatedRequest;
    const controller = new AutomationController(
      db as unknown as PrismaClient,
      { context: verify } as unknown as WorkspaceService,
      f.service,
    );
    expect(await controller.list(req, context.workspaceId)).toEqual([f.slot]);
    expect(await controller.detail(req, context.workspaceId, f.slot.id)).toBe(f.slot);
    expect(db.v9PublishSlot.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: context.workspaceId, id: f.slot.id },
    });
    await expect(controller.detail(req, context.workspaceId, "bad")).rejects.toThrow("UUID");
    verify.mockRejectedValueOnce(new Error("Workspace access denied"));
    await expect(controller.list(req, context.workspaceId)).rejects.toThrow("Workspace");
    verify.mockResolvedValueOnce({ ...context, role: "VIEWER" });
    await expect(controller.retry(req, context.workspaceId, f.run.id)).rejects.toThrow("Editor");
    vi.stubEnv("PIPELINE_V2", "false");
    expect(await controller.list(req, context.workspaceId)).toEqual([]);
    verify.mockRejectedValueOnce(new Error("Workspace access denied"));
    await expect(controller.list(req, context.workspaceId)).rejects.toThrow(
      "Workspace access denied",
    );
  });
});
