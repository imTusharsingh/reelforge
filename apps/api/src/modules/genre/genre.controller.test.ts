import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { GenreService } from "./genre.service.js";
import { GenreController } from "./genre.controller.js";

describe("GenreController templates", () => {
  it("proves workspace membership before listing global templates", async () => {
    const workspaceContext = vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "OWNER",
    });
    const templates = vi.fn().mockResolvedValue([]);
    const controller = new GenreController(
      { templates } as unknown as GenreService,
      { context: workspaceContext } as unknown as WorkspaceService,
    );

    await controller.templates(
      { principal: { userId: "user-1", sessionId: "session-1" } } as AuthenticatedRequest,
      "workspace-1",
    );

    expect(workspaceContext).toHaveBeenCalledWith("user-1", "workspace-1");
    expect(templates).toHaveBeenCalledOnce();
  });
});
