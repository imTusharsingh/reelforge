import { describe, expect, it, vi } from "vitest";
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
});
