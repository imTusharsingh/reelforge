import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { WorkspaceService } from "./workspace.service.js";
import { WorkspaceRepository } from "./workspace.repository.js";
import type { Database } from "../identity/identity.types.js";

function fakeDatabase(): Database {
  const workspaces = new Map([
    ["w1", { id: "w1", name: "One", archivedAt: null }],
    ["w2", { id: "w2", name: "Two", archivedAt: null }],
  ]);
  const memberships = new Map([
    ["u1:w1", { role: "OWNER" as const, workspace: workspaces.get("w1")! }],
    ["u2:w2", { role: "OWNER" as const, workspace: workspaces.get("w2")! }],
  ]);
  return {
    workspaceMembership: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) =>
        memberships.get(
          `${where.workspaceId_userId.userId}:${where.workspaceId_userId.workspaceId}`,
        ) ?? null,
    },
    workspace: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { name?: string; archivedAt?: Date };
      }) => {
        const workspace = workspaces.get(where.id);
        if (!workspace) return { count: 0 };
        Object.assign(workspace, data);
        return { count: 1 };
      },
      findMany: async () => [...workspaces.values()],
      findFirst: async ({ where }: { where: { id: string } }) => workspaces.get(where.id) ?? null,
      create: async () => ({ id: "w3", name: "Three" }),
    },
    user: { update: async () => ({}) },
  } as unknown as Database;
}

describe("WorkspaceService tenant boundary", () => {
  it("denies reading a workspace outside the authenticated user's membership", async () => {
    const db = fakeDatabase();
    const service = new WorkspaceService(db, new WorkspaceRepository(db));
    await expect(service.context("u1", "w2")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies a viewer from mutating a workspace even when the id is supplied directly", async () => {
    const db = fakeDatabase();
    const service = new WorkspaceService(db, new WorkspaceRepository(db));
    await expect(
      service.update({ userId: "u1", workspaceId: "w1", role: "VIEWER" }, "tampered"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("updates only the verified workspace context", async () => {
    const db = fakeDatabase();
    const service = new WorkspaceService(db, new WorkspaceRepository(db));
    await expect(
      service.update({ userId: "u1", workspaceId: "w1", role: "OWNER" }, "Renamed"),
    ).resolves.toEqual({ id: "w1", name: "Renamed" });
  });
});
