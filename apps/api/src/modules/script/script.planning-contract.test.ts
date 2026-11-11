import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { ProviderRegistry } from "@reelforge/ai-providers";
import { ScriptService } from "./script.service.js";

const context = { workspaceId: "workspace-a", userId: "user-a", role: "VIEWER" as const };
const llm = { capability: {} } as never;
type Mock = ReturnType<typeof vi.fn>;
type Fixture = {
  script: { findMany: Mock; findUnique: Mock };
  scriptRevision: { findMany: Mock };
};
function makeDb(): Fixture {
  return {
    script: {
      findMany: vi.fn().mockResolvedValue([{ id: "script-a" }]),
      findUnique: vi.fn().mockResolvedValue({ id: "script-a" }),
    },
    scriptRevision: { findMany: vi.fn().mockResolvedValue([{ revision: 2, document: {} }]) },
  };
}
describe("M24 planning contract: script discovery and version history", () => {
  it("lists only the current workspace, including the latest revision, in bounded pages", async () => {
    const db = makeDb();
    const service = new ScriptService(db as never, llm, new ProviderRegistry());
    await expect(service.list(context, 2)).resolves.toEqual({
      items: [{ id: "script-a" }],
      nextPage: null,
    });
    expect(db.script.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-a" },
        skip: 50,
        take: 51,
        include: { revisions: expect.objectContaining({ take: 1 }) },
      }),
    );
  });
  it("checks tenant ownership before returning history and never exposes prompt text", async () => {
    const db = makeDb();
    const service = new ScriptService(db as never, llm, new ProviderRegistry());
    await service.revisions(context, "script-a", 2);
    expect(db.script.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: "workspace-a", id: "script-a" } },
      select: { id: true },
    });
    expect(db.scriptRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-a", scriptId: "script-a" },
        skip: 50,
        take: 51,
        select: expect.not.objectContaining({ promptText: true }),
      }),
    );
    db.script.findUnique.mockResolvedValue(null);
    await expect(service.revisions(context, "foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.scriptRevision.findMany).toHaveBeenCalledTimes(1);
  });
});
