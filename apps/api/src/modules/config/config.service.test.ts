import { describe, expect, it } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ConfigService } from "./config.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const genreId = "33333333-3333-4333-8333-333333333333";
const seriesId = "44444444-4444-4444-8444-444444444444";

const context = (role: WorkspaceContext["role"] = "OWNER"): WorkspaceContext => ({
  workspaceId,
  userId: "user-1",
  role,
});

function emptyDatabase(): Database {
  return {
    contentSeries: {
      findFirst: async () => null,
    },
  } as unknown as Database;
}

function genreDatabase(rowWorkspaceId: string): Database {
  return {
    genre: {
      findFirst: async ({ where }: { where: { workspaceId: string } }) =>
        where.workspaceId === rowWorkspaceId
          ? {
              id: genreId,
              workspaceId: rowWorkspaceId,
              audience: "Operators",
              tone: "Direct",
              language: "en",
              topicsAllowed: ["education"],
              topicsBlocked: ["hate"],
              structure: { opening: "hook" },
              durationPreference: { minSeconds: 30, maxSeconds: 90 },
              safetyProfile: { level: "standard", requiresHumanReview: true },
            }
          : null,
    },
  } as unknown as Database;
}

describe("ConfigService resolution boundaries", () => {
  it("resolves the same inputs to the same effective config and fingerprints", async () => {
    const service = new ConfigService(emptyDatabase());
    const request = {
      workspaceValues: {
        identity: { tone: "Warm", audience: "Builders" },
        duration: { minSeconds: 20 },
      },
    };

    const first = await service.resolveWithSources(context(), request);
    const second = await service.resolveWithSources(context(), request);

    expect(second.resolved.config).toEqual(first.resolved.config);
    expect(second.resolved.configSha256).toBe(first.resolved.configSha256);
    expect(second.resolved.resolutionSha256).toBe(first.resolved.resolutionSha256);
    expect(second.resolved.config.identity.tone).toBe("Warm");
    expect(first.resolved.config.duration).toEqual({ minSeconds: 20, maxSeconds: 60 });
  });

  it("rejects a lower layer that tries to override a workspace lock", async () => {
    const service = new ConfigService(genreDatabase(workspaceId));

    await expect(
      service.resolveWithSources(context(), {
        workspaceValues: {},
        workspaceLockedFields: ["duration"],
        genreId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("denies a cross-workspace series lookup", async () => {
    const db = {
      contentSeries: {
        findFirst: async ({ where }: { where: { workspaceId: string; id: string } }) =>
          where.workspaceId === otherWorkspaceId && where.id === seriesId
            ? {
                id: seriesId,
                workspaceId: otherWorkspaceId,
                channelId: "55555555-5555-4555-8555-555555555555",
                genreId,
                format: "short",
                frequency: "daily",
                promptRefs: [],
              }
            : null,
      },
    } as unknown as Database;
    const service = new ConfigService(db);

    await expect(
      service.resolveWithSources(context(), { workspaceValues: {}, seriesId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies viewer configuration mutation before touching the database", async () => {
    const service = new ConfigService({
      workspaceConfigSnapshot: {
        findFirst: () => {
          throw new Error("database must not be touched");
        },
      },
    } as unknown as Database);

    await expect(
      service.saveWorkspaceSnapshot(context("VIEWER"), { values: {}, lockedFields: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects protected policy paths supplied as workspace values", async () => {
    const service = new ConfigService(emptyDatabase());

    await expect(
      service.saveWorkspaceSnapshot(context(), {
        values: { safetyPolicy: { minimumLevel: "strict" } },
        lockedFields: [],
      }),
    ).rejects.toThrow("invalid");
  });
});
