import { describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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

  it("rejects non-array genre topics", async () => {
    await expect(
      new GenreService(database()).create(context("w1"), {
        name: "Explainers",
        audience: "General",
        tone: "Clear",
        topicsAllowed: "science",
        topicsBlocked: [],
        language: "en",
        structure: {},
        durationPreference: {},
        safetyProfile: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects null structured genre fields", async () => {
    await expect(
      new GenreService(database()).create(context("w1"), {
        name: "Explainers",
        audience: "General",
        tone: "Clear",
        topicsAllowed: [],
        topicsBlocked: [],
        language: "en",
        structure: null,
        durationPreference: {},
        safetyProfile: {},
      }),
    ).rejects.toThrow("structure must be a non-null object");
  });

  it("rejects a series whose genre language conflicts with its channel", async () => {
    const db = {
      channel: { findFirst: async () => ({ id: "c1", language: "en" }) },
      genre: { findFirst: async () => ({ id: "g1", language: "hi" }) },
    } as unknown as Database;
    await expect(
      new GenreService(db).createSeries(context("w1"), "c1", {
        name: "Daily facts",
        genreId: "g1",
        format: "short",
        frequency: "daily",
        characterGroupRefs: [],
        promptRefs: [],
      }),
    ).rejects.toThrow("Channel language en is incompatible with genre language hi");
  });

  it("rejects non-array series references", async () => {
    await expect(
      new GenreService(database()).createSeries(context("w1"), "c1", {
        name: "Daily facts",
        genreId: "g1",
        format: "short",
        frequency: "daily",
        characterGroupRefs: "group-1",
        promptRefs: [],
      }),
    ).rejects.toThrow("characterGroupRefs must be an array");
  });
});
