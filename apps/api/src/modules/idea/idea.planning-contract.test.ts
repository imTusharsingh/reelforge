import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { IdeaService } from "./idea.service.js";

const context = { workspaceId: "workspace-a", userId: "user-a", role: "EDITOR" as const };
const timestamp = new Date("2026-11-11T10:00:00.000Z");
const draft = {
  title: "New title", topic: "topic", hook: "hook", angle: "angle",
  audience: "audience", references: [], sourceNotes: "", expectedFormat: "short",
  channelId: "channel-a",
};
function makeDb() {
  const row = { id: "idea-a", workspaceId: context.workspaceId, status: "DRAFT",
    archivedAt: null, updatedAt: timestamp };
  return {
    idea: {
      findUnique: vi.fn().mockResolvedValue(row),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ideaApprovalSnapshot: { findUnique: vi.fn().mockResolvedValue(null) },
    channel: { findUnique: vi.fn().mockResolvedValue({ id: "channel-a" }) },
    contentSeries: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}
describe("M24 planning contract: idea edits and archival", () => {
  it("refuses viewer writes before touching the database", async () => {
    const db = makeDb();
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await expect(service.edit({ ...context, role: "VIEWER" }, "idea-a", draft, timestamp))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.archive({ ...context, role: "VIEWER" }, "idea-a", timestamp))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.idea.findUnique).not.toHaveBeenCalled();
  });
  it("only updates the authenticated workspace and matches the last-known timestamp", async () => {
    const db = makeDb();
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await service.edit(context, "idea-a", draft, timestamp);
    expect(db.idea.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace-a", id: "idea-a", updatedAt: timestamp, archivedAt: null }),
      data: expect.objectContaining({ title: "New title", channelId: "channel-a" }),
    }));
  });
  it("blocks stale writes, approved snapshots and foreign records", async () => {
    const db = makeDb();
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    db.idea.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.edit(context, "idea-a", draft, timestamp)).rejects.toBeInstanceOf(ConflictException);
    db.ideaApprovalSnapshot.findUnique.mockResolvedValue({ id: "snapshot-a" });
    await expect(service.edit(context, "idea-a", draft, timestamp)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.archive(context, "idea-a", timestamp)).rejects.toBeInstanceOf(ConflictException);
    db.idea.findUnique.mockResolvedValue(null);
    await expect(service.archive(context, "foreign", timestamp)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("archives without deletion, permits restoration and excludes archives from default lists", async () => {
    const db = makeDb();
    const service = new IdeaService(db as never, { proposeIdea: vi.fn() });
    await service.archive(context, "idea-a", timestamp);
    expect(db.idea.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { archivedAt: expect.any(Date) },
      where: expect.objectContaining({ workspaceId: "workspace-a", archivedAt: null }),
    }));
    db.idea.findUnique.mockResolvedValue({ id: "idea-a", status: "DRAFT", archivedAt: new Date(), updatedAt: timestamp });
    await service.restore(context, "idea-a", timestamp);
    expect(db.idea.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { archivedAt: null } }));
    await service.list(context);
    expect(db.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: "workspace-a", archivedAt: null }),
    }));
  });
});
