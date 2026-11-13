import { HEADERS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import { IdeaController } from "./idea.controller.js";

describe("IdeaController archive routes", () => {
  it("archives through POST and keeps DELETE as a deprecated compatibility route", async () => {
    const archive = vi.fn().mockResolvedValue({ id: "idea-1" });
    const controller = new IdeaController(
      { archive } as never,
      { context: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }) } as never,
    );
    const request = { principal: { userId: "user-1" } } as never;
    const body = { expectedUpdatedAt: "2026-11-13T00:00:00.000Z" };

    await expect(controller.archive(request, "workspace-1", "idea-1", body)).resolves.toEqual({
      id: "idea-1",
    });
    await expect(
      controller.deprecatedArchive(request, "workspace-1", "idea-1", body),
    ).resolves.toEqual({ id: "idea-1" });
    expect(archive).toHaveBeenCalledTimes(2);
    expect(Reflect.getMetadata(PATH_METADATA, IdeaController.prototype.archive)).toBe(
      ":ideaId/archive",
    );
    expect(Reflect.getMetadata(PATH_METADATA, IdeaController.prototype.deprecatedArchive)).toBe(
      ":ideaId",
    );
    expect(
      Reflect.getMetadata(HEADERS_METADATA, IdeaController.prototype.deprecatedArchive),
    ).toEqual([{ name: "Deprecation", value: "true" }]);
  });
});
