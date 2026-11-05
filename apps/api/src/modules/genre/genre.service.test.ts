import { describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { GenreService } from "./genre.service.js";

const context = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  userId: "u1",
  role: "OWNER",
});

function database(): Database {
  return {
    genre: {
      findFirst: async ({ where }: { where: { workspaceId: string; id: string } }) =>
        where.workspaceId === "w1" && where.id === "g1" ? { id: "g1" } : null,
    },
    channel: {
      findFirst: async ({ where }: { where: { workspaceId: string; id: string } }) =>
        where.workspaceId === "w1" && where.id === "c1" ? { id: "c1" } : null,
    },
  } as unknown as Database;
}

describe("GenreService workspace boundaries", () => {
  it("denies a genre from another workspace", async () => {
    await expect(new GenreService(database()).get(context("w2"), "g1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("denies a series channel from another workspace", async () => {
    await expect(new GenreService(database()).series(context("w2"), "c1")).rejects.toThrow(
      "Channel not found",
    );
  });
});
