import { describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "./workspace.service.js";
import { WorkspaceRepository } from "./workspace.repository.js";
import type { Database } from "../identity/identity.types.js";

type MemberRole = "OWNER" | "EDITOR" | "VIEWER";
type Row = {
  id: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
  membership: { userId: string; role: MemberRole }[];
};

function fixture(): { rows: Row[]; service: WorkspaceService } {
  const rows: Row[] = [
    {
      id: "ws-owner",
      name: "Owned",
      archivedAt: null,
      createdAt: new Date("2026-01-01"),
      membership: [{ userId: "user-1", role: "OWNER" }],
    },
    {
      id: "ws-editor",
      name: "Collaborator",
      archivedAt: null,
      createdAt: new Date("2026-01-02"),
      membership: [
        { userId: "user-1", role: "EDITOR" },
        { userId: "user-2", role: "OWNER" },
      ],
    },
    {
      id: "ws-viewer",
      name: "Read only",
      archivedAt: null,
      createdAt: new Date("2026-01-03"),
      membership: [{ userId: "user-1", role: "VIEWER" }],
    },
    {
      id: "ws-private",
      name: "Someone else's workspace",
      archivedAt: null,
      createdAt: new Date("2026-01-04"),
      membership: [{ userId: "user-2", role: "OWNER" }],
    },
    {
      id: "ws-archived",
      name: "Archived",
      archivedAt: new Date("2026-01-05"),
      createdAt: new Date("2026-01-05"),
      membership: [{ userId: "user-1", role: "OWNER" }],
    },
  ];
  const findMany = vi.fn(
    async (args: {
      where: {
        archivedAt: null;
        memberships: { some: { userId: string } };
      };
      select: {
        id: true;
        name: true;
        archivedAt: true;
        memberships: {
          where: { userId: string };
          select: { role: true };
          take: 1;
        };
      };
      orderBy: { createdAt: "asc" };
    }) => {
      const userId = args.where.memberships.some.userId;
      const membershipUserId = args.select.memberships.where.userId;
      // A correct query must scope BOTH membership existence and projected role.
      expect(membershipUserId).toBe(userId);
      expect(args.where.archivedAt).toBeNull();
      expect(args.select.memberships.select).toEqual({ role: true });
      expect(args.select.memberships.take).toBe(1);
      expect(args.orderBy).toEqual({ createdAt: "asc" });
      return rows
        .filter((row) => !row.archivedAt && row.membership.some((m) => m.userId === userId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({
          id: row.id,
          name: row.name,
          archivedAt: row.archivedAt,
          memberships: row.membership
            .filter((m) => m.userId === membershipUserId)
            .slice(0, 1)
            .map((m) => ({ role: m.role })),
        }));
    },
  );
  const db = { workspace: { findMany } } as unknown as Database;
  return {
    rows,
    service: new WorkspaceService(db, new WorkspaceRepository(db)),
  };
}

describe("authenticated workspace membership role read contract", () => {
  it("returns the caller's OWNER, EDITOR and VIEWER roles, in workspace order", async () => {
    const { service } = fixture();
    await expect(service.list("user-1")).resolves.toEqual([
      { id: "ws-owner", name: "Owned", archivedAt: null, role: "OWNER" },
      { id: "ws-editor", name: "Collaborator", archivedAt: null, role: "EDITOR" },
      { id: "ws-viewer", name: "Read only", archivedAt: null, role: "VIEWER" },
    ]);
  });

  it("does not return other tenants' memberships or archived workspaces", async () => {
    const { service } = fixture();
    await expect(service.list("user-2")).resolves.toEqual([
      { id: "ws-editor", name: "Collaborator", archivedAt: null, role: "OWNER" },
      {
        id: "ws-private",
        name: "Someone else's workspace",
        archivedAt: null,
        role: "OWNER",
      },
    ]);
    await expect(service.list("user-not-a-member")).resolves.toEqual([]);
  });

  it("reflects role changes and membership revocation on the next authenticated read", async () => {
    const { service, rows } = fixture();
    await expect(service.list("user-1")).resolves.toContainEqual(
      expect.objectContaining({ id: "ws-editor", role: "EDITOR" }),
    );
    const shared = rows.find((row) => row.id === "ws-editor")!;
    const member = shared.membership.find((m) => m.userId === "user-1")!;
    member.role = "VIEWER";
    await expect(service.list("user-1")).resolves.toContainEqual(
      expect.objectContaining({ id: "ws-editor", role: "VIEWER" }),
    );
    shared.membership = shared.membership.filter((m) => m.userId !== "user-1");
    expect((await service.list("user-1")).some((row) => row.id === "ws-editor")).toBe(false);
  });

  it("excludes a workspace archived after an earlier successful read", async () => {
    const { service, rows } = fixture();
    expect((await service.list("user-1")).some((w) => w.id === "ws-owner")).toBe(true);
    rows.find((row) => row.id === "ws-owner")!.archivedAt = new Date();
    expect((await service.list("user-1")).some((w) => w.id === "ws-owner")).toBe(false);
  });
});
