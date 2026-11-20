import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryController } from "./controller.js";
import { channelId, context } from "./discovery.fixture.js";
afterEach(() => vi.unstubAllEnvs());
describe("V10 learned changes endpoint", () => {
  it("resolves verified membership before reading workspace-scoped learning", async () => {
    const changes = vi.fn().mockResolvedValue([]),
      membership = vi.fn().mockResolvedValue(context);
    const controller = new DiscoveryController(
      { changes } as never,
      { context: membership } as never,
    );
    await expect(
      controller.changes(
        { principal: { userId: context.userId } } as never,
        context.workspaceId,
        channelId,
      ),
    ).resolves.toEqual([]);
    expect(membership).toHaveBeenCalledWith(context.userId, context.workspaceId);
    expect(changes).toHaveBeenCalledWith(context, channelId);
    await expect(controller.changes({} as never, context.workspaceId, "bad-id")).rejects.toThrow(
      "Invalid channel",
    );
    membership.mockRejectedValue(new Error("no membership"));
    await expect(
      controller.changes(
        { principal: { userId: context.userId } } as never,
        context.workspaceId,
        channelId,
      ),
    ).rejects.toThrow("no membership");
  });
});
