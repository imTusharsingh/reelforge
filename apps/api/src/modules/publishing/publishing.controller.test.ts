import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { PublishingService } from "./publishing.service.js";
import { PublishingController } from "./publishing.controller.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const request = {
  principal: { userId: "22222222-2222-4222-8222-222222222222", sessionId: "session" },
} as AuthenticatedRequest;

function controller(publishing: object, role = "VIEWER"): PublishingController {
  return new PublishingController(
    publishing as unknown as PublishingService,
    {
      context: vi.fn().mockResolvedValue({
        workspaceId,
        userId: request.principal.userId,
        role,
      }),
    } as unknown as WorkspaceService,
  );
}

describe("PublishingController M27 reads", () => {
  it("lets a viewer read platform availability", async () => {
    const platforms = vi.fn().mockReturnValue([
      {
        platform: "YOUTUBE",
        connectable: false,
        publishable: false,
        reasonCode: "PLATFORM_NOT_CONFIGURED",
      },
    ]);
    await expect(controller({ platforms }).platforms(request, workspaceId)).resolves.toEqual([
      {
        platform: "YOUTUBE",
        connectable: false,
        publishable: false,
        reasonCode: "PLATFORM_NOT_CONFIGURED",
      },
    ]);
    expect(platforms).toHaveBeenCalledOnce();
  });

  it("lets a viewer read eligible renders", async () => {
    const eligibleRenders = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    await expect(
      controller({ eligibleRenders }).eligibleRenders(request, workspaceId),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(eligibleRenders).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), {});
  });
});

describe("PublishingController idempotent create", () => {
  it("marks a replayed create as 200 without changing the body", async () => {
    const view = { id: "33333333-3333-4333-8333-333333333333" };
    const createScheduledPost = vi.fn(
      async (_context: unknown, _body: unknown, onReplay?: () => void) => {
        onReplay?.();
        return view;
      },
    );
    const status = vi.fn();
    const response = { status } as unknown as Response;
    await expect(
      controller({ createScheduledPost }, "EDITOR").create(request, workspaceId, {}, response),
    ).resolves.toBe(view);
    expect(status).toHaveBeenCalledWith(200);
  });
});
